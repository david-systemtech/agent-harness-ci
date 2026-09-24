import { CLAUDE_CONFIG_DIR } from "./credentials.js";

/**
 * The config-directory queue (claude-adapter spec, "Modules and ownership";
 * Artemis's `withClaudeConfigDir`, ported): the SDK's standalone helpers
 * (`listSessions`, `getSessionMessages`, `getSessionInfo`, `renameSession`,
 * `deleteSession`, `forkSession`, `getSubagentMessages`) take a project
 * directory and a store, never a config directory: they read
 * `CLAUDE_CONFIG_DIR` from the process environment, at call time and again
 * after their own awaits (the pinned 0.3.281 resolves its config home from
 * `process.env` on every call). So a call runs with the variable set to its
 * account's directory and nobody else's, and puts it back afterwards.
 *
 * One queue for the whole process, not one per directory: the variable is
 * process-wide, so two helpers on two directories running together would
 * each read the other's between awaits. Calls run one at a time, in order;
 * a call that fails does not wedge the ones after it.
 */
export interface ConfigDirQueue {
  /**
   * Runs `helper` with the variable at `directory` (always given: an account
   * with none has the ambient default resolved for it), after every call
   * queued before it. A helper that has not answered within the timeout is
   * refused, so a wedged one cannot hold every later call.
   */
  run<T>(directory: string, helper: () => Promise<T>): Promise<T>;
}

export interface ConfigDirQueueOptions {
  /** How long one helper may take; preset 30 s. */
  readonly timeoutMs?: number;
  readonly setTimeout?: (callback: () => void, ms: number) => { cancel(): void };
}

export const CONFIG_DIR_QUEUE_TIMEOUT_MS = 30_000;

const realTimeout = (callback: () => void, ms: number) => {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export const createConfigDirQueue = (env: Record<string, string | undefined> = process.env, options: ConfigDirQueueOptions = {}): ConfigDirQueue => {
  const timeoutMs = options.timeoutMs ?? CONFIG_DIR_QUEUE_TIMEOUT_MS;
  const later = options.setTimeout ?? realTimeout;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(directory: string, helper: () => Promise<T>): Promise<T> {
      const call = tail.then(async () => {
        const previous = env[CLAUDE_CONFIG_DIR];
        env[CLAUDE_CONFIG_DIR] = directory;
        let timer: { cancel(): void } | undefined;
        try {
          return await new Promise<T>((resolve, reject) => {
            timer = later(() => reject(new Error(`A Claude session helper did not answer within ${timeoutMs} ms.`)), timeoutMs);
            Promise.resolve()
              .then(helper)
              .then(resolve, (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
          });
        } finally {
          timer?.cancel();
          if (previous === undefined) delete env[CLAUDE_CONFIG_DIR];
          else env[CLAUDE_CONFIG_DIR] = previous;
        }
      });
      tail = call.then(
        () => undefined,
        () => undefined,
      );
      return call;
    },
  };
};

/** The process's queue: every Claude adapter in the process shares it, as they share the variable. */
export const configDirQueue: ConfigDirQueue = createConfigDirQueue();
