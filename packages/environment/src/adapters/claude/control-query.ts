import type { RunSkillSet } from "@agent-harness/contracts";
import { query as sdkQuery, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProbeTimeoutError } from "../../adapter/probe.js";
import type { Clock, Timer } from "../../serve/clock.js";
import { composeRunEnvironment, type HostEnvironment } from "./credentials.js";
import { CLIENT_APP, flagSettings, projectOptions, skillPlugins } from "./options.js";

/**
 * A query that is never sampled (the models fetch and the plan-usage read,
 * one helper here): the SDK serves its control requests (the usage
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
  /** The account's config directory, resolved. */
  readonly directory: string;
  readonly cwd: string;
  /**
   * The skill set to load as a run would, the generation as its plugin and
   * the hidden native names off: only the commands listing passes one,
   * since only it describes what a run would offer.
   */
  readonly skillSet?: RunSkillSet;
  /** Whether the workspace's repository passed the trust gate: its project settings then load, as a run's would. */
  readonly trusted?: boolean;
  /** The main checkout of the linked worktree `cwd` lies in, whose project configuration a trusted run there loads (#998). */
  readonly checkoutRoot?: string | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** A skill set's plugin and flag settings as a run's options carry them (`options.ts`); nothing without a set. */
const skillOptions = (skillSet: RunSkillSet | undefined): Pick<Options, "plugins" | "settings"> => {
  if (skillSet === undefined) return {};
  const plugins = skillPlugins(skillSet);
  // No auto-memory directory: a listing keeps no memory, so the flag settings carry only what hides a skill.
  const settings = flagSettings(null, skillSet);
  return { ...(plugins.length > 0 && { plugins }), ...(settings !== null && { settings }) };
};

export const withControlQuery = async <T>(options: ControlQueryOptions, ask: (query: Query) => Promise<T>): Promise<T> => {
  options.signal?.throwIfAborted();
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
    ...projectOptions(options.trusted === true, options.checkoutRoot ?? null),
    strictMcpConfig: true,
    includePartialMessages: false,
    // Nothing is said, so nothing is kept: no transcript file for a query that never ran a turn.
    persistSession: false,
    ...(options.executablePath !== null && { pathToClaudeCodeExecutable: options.executablePath }),
    ...skillOptions(options.skillSet),
  };
  let query: Query | undefined;
  let timer: Timer | undefined;
  let cancelled: (() => void) | undefined;
  try {
    query = sdkQuery({ prompt: idle, options: queryOptions });
    const asked = ask(query);
    return await new Promise<T>((resolve, reject) => {
      cancelled = () => { abort.abort(); reject(options.signal?.reason); };
      timer = options.clock.setTimeout(() => reject(new ProbeTimeoutError(`The Claude binary did not answer within ${options.timeoutMs} ms.`)), options.timeoutMs);
      options.signal?.addEventListener("abort", cancelled, { once: true });
      if (options.signal?.aborted === true) cancelled();
      asked.then(resolve, reject);
    });
  } finally {
    timer?.cancel();
    if (cancelled !== undefined) options.signal?.removeEventListener("abort", cancelled);
    abort.abort();
    try {
      query?.close();
    } catch {
      // The abort is what reclaims the process.
    }
  }
};
