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
  /** Runs `helper` with the variable at `directory` (null: the host's own), after every call queued before it. */
  run<T>(directory: string | null, helper: () => Promise<T>): Promise<T>;
}

export const createConfigDirQueue = (env: Record<string, string | undefined> = process.env): ConfigDirQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(directory: string | null, helper: () => Promise<T>): Promise<T> {
      const call = tail.then(async () => {
        const previous = env[CLAUDE_CONFIG_DIR];
        if (directory !== null) env[CLAUDE_CONFIG_DIR] = directory;
        try {
          return await helper();
        } finally {
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
