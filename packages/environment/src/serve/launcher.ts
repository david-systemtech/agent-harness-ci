import type { DrainStarted, EnvironmentStatus } from "@agent-harness/contracts";

/**
 * The child's side of the launcher's channel (ADR 0007), and the one place
 * its messages are defined. The environment sends `{type: "prepared"}` once
 * its startup gate is passed, so a trial version that cannot serve is rolled
 * back. After that the launcher may ask two things, each answered with one
 * reply:
 *
 * - `{type: "idle?"}` → `{type: "idle", ...status}`: the status document
 *   `environment.status` answers (readiness, activity, updatesManagedOutside);
 *   the environment is idle when `activity.state` is `idle`.
 * - `{type: "drain?"}` → `{type: "draining", ...DrainStarted}`: the drain
 *   begins, or the one under way is joined, and the reply says since when and
 *   what started it.
 *
 * Any other message is ignored. The channel is let go by `close`, which the
 * environment calls last when it closes (or when a start fails), so an open
 * channel never keeps a finished process alive.
 */
export type LauncherQuery = { readonly type: "idle?" } | { readonly type: "drain?" };

/** The environment's reply to a `LauncherQuery`, as the pairs above. */
export type LauncherReply = ({ readonly type: "idle" } & EnvironmentStatus) | ({ readonly type: "draining" } & DrainStarted);

export interface LauncherChannel {
  /** Whether a launcher is behind the channel; with none, and in a container, updates are managed outside. */
  present(): boolean;
  prepared(): void | Promise<void>;
  /** Answers the launcher's queries with `answer` from now until `close`; the environment calls it once, when it is ready. */
  onQuery(answer: (query: LauncherQuery) => LauncherReply): void;
  close(): void | Promise<void>;
}

/** The message a launcher that spawned the environment with an IPC channel receives. */
export const PREPARED_MESSAGE = { type: "prepared" } as const;

/** The parts of `process` the preset uses. */
export interface IpcProcess {
  readonly connected: boolean;
  readonly send?: ((message: unknown, callback: (error: Error | null) => void) => boolean) | undefined;
  readonly disconnect: () => void;
  /** Hears every message the launcher sends; returns the unsubscribe. */
  readonly onMessage?: ((listener: (message: unknown) => void) => () => void) | undefined;
}

/** The query `message` is, if it is one; the launcher's other messages are not the environment's to answer. */
const queryOf = (message: unknown): LauncherQuery | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  return type === "idle?" || type === "drain?" ? { type } : undefined;
};

const ipcOf = (proc: NodeJS.Process): IpcProcess => {
  const send = proc.send?.bind(proc);
  return {
    get connected() {
      return proc.connected;
    },
    send: send ? (message, callback) => send(message, undefined, {}, callback) : undefined,
    disconnect: () => proc.disconnect(),
    onMessage: (listener) => {
      proc.on("message", listener);
      return () => void proc.off("message", listener);
    },
  };
};

/**
 * The preset channel: over the IPC channel when a launcher spawned the
 * environment with one, and a no-op when `serve` runs in the foreground.
 * A signal the channel cannot deliver, or a launcher that disconnected before
 * the gate, fails the start. Each query is answered with one reply message;
 * a reply the launcher is no longer there to take is dropped; the foreground
 * channel ignores queries, since no launcher asks them. `close` stops
 * listening and disconnects the channel if it is still connected.
 */
export const processLauncherChannel = (proc: IpcProcess = ipcOf(process)): LauncherChannel => {
  let stopListening: (() => void) | undefined;
  return {
    present: () => proc.send !== undefined,
    prepared: () => {
      const send = proc.send;
      if (!send) return Promise.resolve();
      // A launcher spawned this environment and has since gone: the gate cannot be reported, so the start fails.
      if (!proc.connected) return Promise.reject(new Error("The launcher's channel disconnected before prepared could be sent."));
      return new Promise<void>((resolve, reject) => {
        send(PREPARED_MESSAGE, (error) => (error ? reject(error) : resolve()));
      });
    },
    onQuery: (answer) => {
      const send = proc.send;
      if (!send || !proc.onMessage) return;
      stopListening?.();
      stopListening = proc.onMessage((message) => {
        const query = queryOf(message);
        if (!query) return;
        try {
          const reply = answer(query);
          if (proc.connected) send(reply, () => undefined);
        } catch (error) {
          console.error(`Answering the launcher's ${query.type} query failed:`, error);
        }
      });
    },
    close: async () => {
      stopListening?.();
      stopListening = undefined;
      if (proc.send && proc.connected) proc.disconnect();
    },
  };
};
