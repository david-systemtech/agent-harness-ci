import { query as sdkQuery, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Clock } from "../../serve/clock.js";
import { composeRunEnvironment, type HostEnvironment } from "./credentials.js";
import { CLIENT_APP } from "./options.js";

/**
 * A query that is never sampled (Artemis's `fetchClaudeModels` and plan-usage
 * read, one helper here): the SDK serves its control requests (the usage
 * read, `accountInfo`, `supportedModels`, `supportedCommands`) only over a
 * streaming session, so the cheapest legal path is a query whose prompt
 * never yields, asked on the control channel and torn down. No turn starts,
 * nothing is billed, and the process lives for one round trip, under the
 * account's directory with the stripped variables absent, loading no
 * settings and no MCP server of its own.
 */

export interface ControlQueryOptions {
  readonly clock: Pick<Clock, "setTimeout">;
  readonly hostEnv: HostEnvironment;
  readonly executablePath: string | null;
  readonly directory: string | null;
  readonly cwd: string;
  readonly pluginDirectory?: string | null;
  readonly timeoutMs: number;
}

export const withControlQuery = async <T>(options: ControlQueryOptions, ask: (query: Query) => Promise<T>): Promise<T> => {
  const abort = new AbortController();
  // Yields nothing and parks until the abort: ending would close the input and let the CLI end the session before the request lands.
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          const done = () => resolve({ value: undefined, done: true });
          if (abort.signal.aborted) done();
          else abort.signal.addEventListener("abort", done, { once: true });
        }),
    }),
  };
  const queryOptions: Options = {
    cwd: options.cwd,
    env: composeRunEnvironment(options.hostEnv, options.directory, { CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }),
    abortController: abort,
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: false,
    ...(options.executablePath !== null && { pathToClaudeCodeExecutable: options.executablePath }),
    ...(options.pluginDirectory !== undefined && options.pluginDirectory !== null && { plugins: [{ type: "local", path: options.pluginDirectory }] }),
  };
  let query: Query | undefined;
  try {
    query = sdkQuery({ prompt: idle, options: queryOptions });
    const asked = ask(query);
    return await new Promise<T>((resolve, reject) => {
      const timer = options.clock.setTimeout(() => reject(new Error(`The Claude binary did not answer within ${options.timeoutMs} ms.`)), options.timeoutMs);
      asked.then(
        (value) => {
          timer.cancel();
          resolve(value);
        },
        (error: unknown) => {
          timer.cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  } finally {
    abort.abort();
    try {
      query?.close();
    } catch {
      // The abort is what reclaims the process.
    }
  }
};
