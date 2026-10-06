import {
  LAUNCHER_PROTOCOL,
  parseEnvironmentMessage,
  type EnvironmentMessage,
  type EnvironmentRequest,
  type InstallAnswer,
  type LauncherAnswer,
  type LauncherMessage,
  type LauncherQuery,
  type LauncherReply,
  type PreparedMessage,
  type SwitchAnswer,
  type VersionsAnswer,
} from "@agent-harness/contracts/launcher";
import { processLauncherChannel, type IpcProcess, type LauncherChannel } from "../src/serve/launcher.js";
import { HARNESS_VERSION } from "../src/serve/start.js";

/** How a scripted launcher answers one kind of request: from the request, at once or later. */
type Script<T extends EnvironmentRequest["type"], A> = (request: Extract<EnvironmentRequest, { readonly type: T }>) => A | Promise<A>;

export interface TestLauncherOptions {
  /** Whether a launcher is behind the channel. Preset: none, as under a foreground `serve`. */
  readonly present?: boolean;
  /** How `prepared` is answered: `committed` at once (preset), or held until the test calls `commit`. */
  readonly commit?: "at-once" | "held";
  /** How `install?` is answered. Preset: `installed`. */
  readonly install?: Script<"install?", InstallAnswer>;
  /** How `switch?` is answered. Preset: `switching`. */
  readonly switch?: Script<"switch?", SwitchAnswer>;
  /** How `versions?` is answered. Preset: this build's version installed, under a launcher of the same version on `LAUNCHER_PROTOCOL`. */
  readonly versions?: Script<"versions?", VersionsAnswer>;
}

/**
 * The scripted launcher channel, the seam every update test drives: the
 * environment's own channel (`processLauncherChannel`) over an in-memory IPC
 * channel to a launcher that reads and answers the messages as the contracts
 * define them, as each test scripts. With no launcher present the channel
 * has none behind it, as under a foreground `serve`.
 */
export interface TestLauncher extends LauncherChannel {
  /** What reached the channel, in order, whether or not a launcher is behind it: `prepared`, `close`. */
  readonly signals: readonly string[];
  /** Every message the environment sent the launcher, as the launcher read it, in order: requests carry their ids. */
  readonly received: readonly EnvironmentMessage[];
  /** Settles once the environment has said `prepared`, with that message. */
  heardPrepared(): Promise<PreparedMessage>;
  /** Answers a held `prepared` with `committed`; throws when none is held. */
  commit(): void;
  /** The environment's answer to `query`; throws when the environment answers no launcher queries on this channel now. */
  ask(query: LauncherQuery): LauncherReply;
  /** Puts `message` on the channel as the launcher, whatever it is: a message the environment does not know, say. */
  send(message: unknown): void;
  /** The launcher goes: the channel disconnects from its side. */
  leave(): void;
}

/** A message as the other side of the IPC channel receives it, which carries JSON. */
const overIpc = (message: unknown): unknown => (message === undefined ? undefined : (JSON.parse(JSON.stringify(message)) as unknown));

/** A scripted launcher channel; preset: no launcher present. */
export const testLauncher = (options: TestLauncherOptions = {}): TestLauncher => {
  const present = options.present ?? false;
  const scripts = {
    "install?": options.install ?? ((): InstallAnswer => ({ type: "installed" })),
    "switch?": options.switch ?? ((): SwitchAnswer => ({ type: "switching" })),
    "versions?":
      options.versions ??
      ((): VersionsAnswer => ({ type: "versions", installed: [HARNESS_VERSION], launcherVersion: HARNESS_VERSION, launcherProtocol: LAUNCHER_PROTOCOL })),
  };
  const signals: string[] = [];
  const received: EnvironmentMessage[] = [];
  const replies: LauncherReply[] = [];
  const environmentListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  let connected = present;
  let commitHeld = false;
  let heard!: (message: PreparedMessage) => void;
  const prepared = new Promise<PreparedMessage>((resolve) => (heard = resolve));

  /** Hands `message` to the environment, as the IPC channel does: a copy, and only while it is connected. */
  const deliver = (message: unknown) => {
    if (!connected) return;
    for (const listener of [...environmentListeners]) listener(overIpc(message));
  };
  /** Answers a request once its script has, as a later message. */
  const answer = (id: number, script: () => LauncherAnswer | Promise<LauncherAnswer>) =>
    void Promise.resolve()
      .then(script)
      .then((reply) => deliver({ ...reply, id } satisfies LauncherMessage));

  /** The launcher reading what the environment sent: a message it does not know is ignored, as `launch` ignores it. */
  const hear = (raw: unknown) => {
    const message = parseEnvironmentMessage(overIpc(raw));
    if (message === undefined) return;
    received.push(message);
    switch (message.type) {
      case "prepared":
        heard(message);
        if (options.commit === "held") commitHeld = true;
        else queueMicrotask(() => deliver({ type: "committed" }));
        return;
      case "install?": {
        const { id, ...request } = message;
        return answer(id, () => scripts["install?"](request));
      }
      case "switch?": {
        const { id, ...request } = message;
        return answer(id, () => scripts["switch?"](request));
      }
      case "versions?": {
        const { id, ...request } = message;
        return answer(id, () => scripts["versions?"](request));
      }
      // Where a start's OS keychain read stands asks nothing of a launcher that commits at once.
      case "credential-access":
        return;
      default:
        replies.push(message);
    }
  };

  const ipc: IpcProcess = {
    get connected() {
      return connected;
    },
    send: present
      ? (message, callback) => {
          if (!connected) {
            callback(new Error("The launcher's channel is closed."));
            return false;
          }
          hear(message);
          callback(null);
          return true;
        }
      : undefined,
    disconnect: () => void (connected = false),
    onMessage: (listener) => {
      environmentListeners.add(listener);
      return () => void environmentListeners.delete(listener);
    },
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => void disconnectListeners.delete(listener);
    },
  };
  const channel = processLauncherChannel(ipc);

  return {
    signals,
    received,
    present: () => channel.present(),
    prepared: (version) => {
      signals.push("prepared");
      return channel.prepared(version);
    },
    onQuery: (respond) => channel.onQuery(respond),
    request: channel.request,
    close: () => {
      signals.push("close");
      return channel.close();
    },
    heardPrepared: () => prepared,
    commit() {
      if (!commitHeld) throw new Error("No prepared is waiting for this launcher's commit.");
      commitHeld = false;
      deliver({ type: "committed" });
    },
    ask(query) {
      const before = replies.length;
      deliver(query);
      const reply = replies[before];
      if (reply === undefined) throw new Error("The environment answers no launcher queries on this channel now.");
      return reply;
    },
    send: deliver,
    leave() {
      connected = false;
      for (const listener of [...disconnectListeners]) listener();
    },
  };
};
