import type { EnvironmentActivity } from "@agent-harness/contracts";

/**
 * What the launcher asks the environment once it is ready: whether it is
 * idle (ADR 0007's rule, the same answer `environment.status` gives), and to
 * drain.
 */
export type LauncherQuery = { readonly type: "idle?" } | { readonly type: "drain" };

/**
 * The environment's reply to a query: `idle` with the activity
 * `environment.status` reports, flattened beside `idle`; `draining` once a
 * drain has started (or was already under way), since when.
 */
export type LauncherReply =
  | ({ readonly type: "idle"; readonly idle: boolean } & EnvironmentActivity)
  | { readonly type: "draining"; readonly drainingSince: string };

/**
 * The child's side of the launcher's channel (ADR 0007). The environment says
 * `prepared` once its startup gate is passed, so a trial version that cannot
 * serve is rolled back. The channel stays open after that for the launcher's
 * idle and drain queries, which `onQuery` answers from the environment's
 * lifecycle, and is let go by `close`, which the environment calls last when
 * it closes (or when a start fails), so an open channel never keeps a
 * finished process alive.
 */
export interface LauncherChannel {
  prepared(): void | Promise<void>;
  /**
   * Answers the launcher's queries with `answer` from now until `close`. The
   * environment calls it once, when it is ready. A channel with no launcher
   * behind it may leave it out.
   */
  onQuery?(answer: (query: LauncherQuery) => LauncherReply): void;
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
  return type === "idle?" || type === "drain" ? { type } : undefined;
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
 * a reply the launcher is no longer there to take is dropped. `close` stops
 * listening and disconnects the channel if it is still connected.
 */
export const processLauncherChannel = (proc: IpcProcess = ipcOf(process)): LauncherChannel => {
  let stopListening: (() => void) | undefined;
  return {
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
