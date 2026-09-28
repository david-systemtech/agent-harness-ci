import { CLAUDE_CONFIG_DIR } from "./credentials.js";

/**
 * The config-directory queue (claude-adapter spec, "Modules and ownership"):
 * the SDK's standalone helpers
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
 *
 * A call is answered within the timeout of being asked, or refused. The
 * pinned SDK's helpers take no abort signal, so a helper refused for its
 * time may still be running, and read the variable again, or write under it,
 * once whatever held it lets go: its directory therefore stays installed, and
 * the queue does not move on, until it settles. A call whose time runs out
 * while it waits is refused and never runs, so a helper that never settles
 * holds the queue but keeps no caller waiting past its time.
 */
export interface ConfigDirQueue {
  /**
   * Runs `helper` with the variable at `directory` (always given: an account
   * with none has the ambient default resolved for it), after every call
   * queued before it has settled. A call not answered within the timeout of
   * being asked is refused: if its helper had begun, the variable stays at
   * `directory` until the helper settles; if not, it never runs.
   */
  run<T>(directory: string, helper: () => Promise<T>): Promise<T>;
}

export interface ConfigDirQueueOptions {
  /** How long a call may take from being asked to its answer; preset 30 s. */
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
  /** Settles once every call queued so far has settled, its helper included when it outlived its time; never rejects. */
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(directory: string, helper: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let refused = false;
        const timer = later(() => {
          refused = true;
          reject(new Error(`A Claude session helper did not answer within ${timeoutMs} ms.`));
        }, timeoutMs);
        tail = tail.then(async () => {
          // Refused while it waited: its caller has its answer, so it never runs.
          if (refused) return;
          const previous = env[CLAUDE_CONFIG_DIR];
          env[CLAUDE_CONFIG_DIR] = directory;
          try {
            // Awaited past the timeout: a refused helper keeps its directory, and the queue, until it settles.
            resolve(await Promise.resolve().then(helper));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            timer.cancel();
            if (previous === undefined) delete env[CLAUDE_CONFIG_DIR];
            else env[CLAUDE_CONFIG_DIR] = previous;
          }
        });
      });
    },
  };
};

/** The process's queue: every Claude adapter in the process shares it, as they share the variable. */
export const configDirQueue: ConfigDirQueue = createConfigDirQueue();
