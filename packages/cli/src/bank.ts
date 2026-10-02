import { PRODUCT_NAME, type MemorySearchInput } from "@agent-harness/contracts";
import { defaultDataDirectory } from "@agent-harness/environment";
import { parsePort, parseVerb, UsageError } from "./args.js";
import { LocalFailure, LocalRefusal, withLocalSession, type LocalCall, type Net } from "./local-session.js";

/**
 * The `bank` verbs (banks spec, "CLI"; #1044): a Claude Code session outside
 * the harness searches, reads, drafts and promotes memories in the banks of
 * the environment on this machine, as a run's `memory` tools do, and
 * validates a bank's files as the bank's CI does. Each verb that asks the
 * environment reaches it through the bootstrap grant, as `pair` does
 * (`local-session.ts`), and is answered by the operations the tools use.
 */

export const BANK_USAGE = [
  `${PRODUCT_NAME} bank search <query> [--bank <name>] [--scope <org>[/<project>[/<area>]]] [--limit <n>] [--data-dir <path>] [--port <n>]`,
] as const;

export interface BankContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly net: Net;
  /** The directory the caller works in, whose repository scopes the banks as a session's workspace does. */
  readonly cwd: string;
}

/** The options every verb that asks the environment takes: which environment. */
const TARGET_OPTIONS = { "data-dir": { type: "string" }, port: { type: "string" } } as const;

/**
 * Runs `work` on the environment on this machine as the verb's own local
 * client session, with the repository identity of the directory the caller
 * works in (none outside a repository, or where git cannot say, as a
 * session's workspace gets none).
 */
const onEnvironment = <T>(
  verb: string,
  values: { readonly "data-dir"?: string | undefined; readonly port?: string | undefined },
  context: BankContext,
  work: (call: LocalCall, repositoryIdentity: string | null) => Promise<T>,
): Promise<T> =>
  withLocalSession({ dataDir: values["data-dir"] ?? defaultDataDirectory(), port: parsePort(values.port, 1) }, context.net, `${PRODUCT_NAME} bank ${verb}`, async (call) => {
    let repositoryIdentity: string | null = null;
    try {
      repositoryIdentity = (await call("workspaces.inspect", { path: context.cwd })).repository?.repositoryIdentity ?? null;
    } catch (error) {
      if (!(error instanceof LocalRefusal)) throw error;
    }
    return work(call, repositoryIdentity);
  });

/** `--scope org[/project[/area]]` as the tools' scope labels; a search may name an org alone. */
const parseScope = (value: string): MemorySearchInput["scope"] => {
  const [org, project, area, ...rest] = value.replace(/\/$/, "").split("/");
  if (org === undefined || org === "" || rest.length > 0) throw new UsageError(`--scope takes <org>[/<project>[/<area>]]; got ${value}.`);
  if (project === undefined) return { org };
  return { org, project, ...(area !== undefined && { area }) };
};

/** `--limit`: how many hits a search prints, from 1 to 100. */
const parseLimit = (value: string): number => {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new UsageError(`--limit takes a number from 1 to 100; got ${value}.`);
  return Number(value);
};

/** `bank search <query>`: what the memory tool's search answers, each hit as its pointer and line, then "n of N". */
const search = async (args: readonly string[], context: BankContext): Promise<number> => {
  const { values, positionals } = parseVerb(args, { ...TARGET_OPTIONS, bank: { type: "string" }, scope: { type: "string" }, limit: { type: "string" } });
  const [query, ...rest] = positionals;
  if (query === undefined || rest.length > 0) throw new UsageError("bank search takes one query.");
  const input: MemorySearchInput = {
    query,
    ...(values.bank !== undefined && { bank: values.bank }),
    ...(values.scope !== undefined && { scope: parseScope(values.scope) }),
    ...(values.limit !== undefined && { limit: parseLimit(values.limit) }),
  };
  const { text } = await onEnvironment("search", values, context, (call, repositoryIdentity) => call("banks.memory.search", { ...input, repositoryIdentity }));
  context.stdout(text);
  return 0;
};

/** The `bank` verbs by name. */
const VERBS: Readonly<Record<string, (args: readonly string[], context: BankContext) => Promise<number>>> = { search };

/**
 * `bank`: runs the verb `args` name. Exits as the verb does, 1 with a plain
 * sentence when no environment answers or it refuses, and 2 (the CLI's
 * usage error) on arguments it cannot parse.
 */
export const bank = async (args: readonly string[], context: BankContext): Promise<number> => {
  const [verb, ...rest] = args;
  const run = verb === undefined || !Object.hasOwn(VERBS, verb) ? undefined : VERBS[verb];
  if (run === undefined) throw new UsageError(verb === undefined ? `bank takes a verb: ${Object.keys(VERBS).join(", ")}.` : `Unknown bank verb ${verb}.`);
  try {
    return await run(rest, context);
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};
