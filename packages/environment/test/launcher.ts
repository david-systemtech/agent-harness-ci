import type { LauncherChannel, LauncherQuery, LauncherReply } from "../src/serve/launcher.js";

/**
 * A launcher channel for tests: it records what the environment signals, and
 * `ask` puts a query to the environment as the launcher would over IPC and
 * returns the environment's reply.
 */
export interface TestLauncher extends LauncherChannel {
  /** What reached the channel, in order: `prepared`, `close`. */
  readonly signals: readonly string[];
  /** The environment's answer to `query`; throws before the environment answers queries and after the channel is closed. */
  ask(query: LauncherQuery): LauncherReply;
}

export const testLauncher = (): TestLauncher => {
  const signals: string[] = [];
  let answer: ((query: LauncherQuery) => LauncherReply) | undefined;
  return {
    signals,
    prepared: () => void signals.push("prepared"),
    onQuery: (respond) => void (answer = respond),
    close: () => {
      signals.push("close");
      answer = undefined;
    },
    ask(query) {
      if (!answer) throw new Error("The environment answers no launcher queries on this channel now.");
      return answer(query);
    },
  };
};
