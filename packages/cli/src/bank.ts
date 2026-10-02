import * as fs from "node:fs";
import { resolve } from "node:path";
import { BankRequiredError, MEMORY_TYPES, PRODUCT_NAME, SessionId, ValidationFailedError, type MemoryDraftInput, type MemoryPromoteResult, type MemorySearchInput } from "@agent-harness/contracts";
import { bankFindingLine, bankVerdictText, readBankFolder, validateBank } from "@agent-harness/contracts/bank-validator";
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
  `${PRODUCT_NAME} bank validate [<bank directory>] [--json]`,
  `${PRODUCT_NAME} bank search <query> [--bank <name>] [--scope <org>[/<project>[/<area>]]] [--limit <n>] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} bank read [<pointer>] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} bank draft <name> --scope <org>/<project>[/<area>] [--topic <topic>] --type <${MEMORY_TYPES.join("|")}> --description <text> --body <text|-> [--applies-to <repository>]... [--bank <name>] [--session <id>] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} bank promote [--bank <name>] [--session <id>] [--data-dir <path>] [--port <n>]`,
] as const;

export interface BankContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly net: Net;
  /** The directory the caller works in, whose repository scopes the banks as a session's workspace does. */
  readonly cwd: string;
  /** The process's variables: a Claude Code session's own id names the draft queue when `--session` does not. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Standard input, which `draft --body -` reads the body from. */
  readonly stdin: () => Promise<string>;
}

/** The variable a Claude Code session sets to its own id in the commands it runs. */
const CLAUDE_SESSION_VARIABLE = "CLAUDE_CODE_SESSION_ID";

/**
 * How long `promote` waits for the landing's answer: the Lander waits up to
 * ten minutes on the bank's validate check (banks spec, "Landing"), then
 * merges, fetches and verifies main.
 */
const PROMOTE_WAIT_MS = 15 * 60_000;

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
const parseScope = (value: string): NonNullable<MemorySearchInput["scope"]> => {
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

/** An option the verb cannot go without. */
const required = (option: string, value: string | undefined): string => {
  if (value === undefined) throw new UsageError(`${option} is required.`);
  return value;
};

/**
 * The session whose draft queue a draft joins and a promote lands: `--session`, else the Claude Code session's own
 * id, so one outside session's drafts stay together across its invocations and land in its own promote.
 */
const queueSession = (option: string | undefined, env: BankContext["env"]): string => {
  const given = option ?? env[CLAUDE_SESSION_VARIABLE]?.trim();
  if (given === undefined || given === "") throw new UsageError(`Name the session whose draft queue this is with --session <id>; a Claude Code session's own ${CLAUDE_SESSION_VARIABLE} is taken when it is set.`);
  const id = SessionId.safeParse(given);
  if (!id.success) throw new UsageError(`${option === undefined ? CLAUDE_SESSION_VARIABLE : "--session"} takes a session id, a version 4 UUID; got ${given}.`);
  return id.data;
};

/**
 * `bank validate [<bank directory>]`: the bank whose working tree is there
 * (the working directory by default) judged by the contracts' versioned
 * validator, read and printed as the bank's CI reads and prints it
 * (`validate.mjs`): each finding with its rule id, then the validator's
 * stamp and the verdict, or with `--json` the verdict as the functions give
 * it. Exits 1 when a finding refuses. It asks no environment.
 */
const validate = async (args: readonly string[], context: BankContext): Promise<number> => {
  const { values, positionals } = parseVerb(args, { json: { type: "boolean" } });
  const [directory, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError("bank validate takes at most one bank directory.");
  const verdict = validateBank(readBankFolder(resolve(context.cwd, directory ?? "."), fs));
  context.stdout(values.json ? `${JSON.stringify(verdict)}\n` : bankVerdictText(verdict));
  return verdict.valid ? 0 : 1;
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

/** `bank read [<pointer>]`: what the memory tool's read answers: every bank's line, a bank's root, a folder's or topic's index, or a memory's file, each ending with its folder and count. */
const read = async (args: readonly string[], context: BankContext): Promise<number> => {
  const { values, positionals } = parseVerb(args, TARGET_OPTIONS);
  const [pointer, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError("bank read takes at most one pointer.");
  const { text } = await onEnvironment("read", values, context, (call, repositoryIdentity) => call("banks.memory.read", { ...(pointer !== undefined && { pointer }), repositoryIdentity }));
  context.stdout(text);
  return 0;
};

/**
 * `bank draft <name>`: validates a memory and queues it for the session and
 * the bank, as the memory tool's draft does; a draft of a name the bank or the
 * queue holds replaces it. Refused with the validator's rule ids, or when
 * several writable banks are in scope and `--bank` names none.
 */
const draft = async (args: readonly string[], context: BankContext): Promise<number> => {
  const { values, positionals } = parseVerb(args, {
    ...TARGET_OPTIONS, bank: { type: "string" }, scope: { type: "string" }, topic: { type: "string" }, type: { type: "string" },
    description: { type: "string" }, body: { type: "string" }, "applies-to": { type: "string", multiple: true }, session: { type: "string" },
  });
  const [name, ...rest] = positionals;
  if (name === undefined || rest.length > 0) throw new UsageError("bank draft takes one memory name.");
  const scope = parseScope(required("--scope", values.scope));
  if (!("project" in scope)) throw new UsageError(`--scope of a draft takes <org>/<project>[/<area>]; got ${values.scope}.`);
  const type = MEMORY_TYPES.find((known) => known === values.type);
  if (type === undefined) throw new UsageError(`--type takes ${MEMORY_TYPES.join(", ")}; got ${values.type ?? "none"}.`);
  const description = required("--description", values.description);
  const body = required("--body", values.body);
  const queue = queueSession(values.session, context.env);
  const input: MemoryDraftInput = {
    name, scope, type, description,
    body: body === "-" ? await context.stdin() : body,
    ...(values.topic !== undefined && { topic: values.topic }),
    ...(values["applies-to"] !== undefined && { appliesTo: values["applies-to"] }),
    ...(values.bank !== undefined && { bank: values.bank }),
  };
  const queued = await onEnvironment("draft", values, context, (call, repositoryIdentity) => call("banks.memory.draft", { ...input, queue, repositoryIdentity }));
  context.stdout(`Queued ${queued.change.name} for ${queued.bank} at ${queued.change.path} (session ${queue}).\n`);
  for (const path of queued.change.removePaths ?? []) context.stdout(`  replacing ${path}\n`);
  return 0;
};

/** What a promotion came to, a line for the bank and one per file: on main, awaiting review, or why it failed. */
const promotionLines = (promotion: MemoryPromoteResult): string => {
  switch (promotion.state) {
    case "landed":
      if (promotion.files.length === 0) return `Landed in ${promotion.bank}: no queued changes.\n`;
      return [`Landed in ${promotion.bank}:${promotion.pullRequest === null ? "" : ` ${promotion.pullRequest}`}`, ...promotion.files.map((file) => `  ${file.state} ${file.path}`), ""].join("\n");
    case "awaiting-review":
      return [`Awaiting review in ${promotion.bank}: ${promotion.pullRequest}`, ...promotion.files.map((file) => `  ${file.state} ${file.path}`), ""].join("\n");
    case "failed":
      return `Landing in ${promotion.bank} failed at ${promotion.step}: ${promotion.reason}\n`;
  }
};

/**
 * `bank promote`: lands the session's queue for the bank through the
 * Lander, as the memory tool's promote does, and prints each file's state:
 * verified on main, awaiting review with the pull request, or the step and
 * reason it failed, which exits 1.
 */
const promote = async (args: readonly string[], context: BankContext): Promise<number> => {
  const { values, positionals } = parseVerb(args, { ...TARGET_OPTIONS, bank: { type: "string" }, session: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("bank promote takes no arguments but its options.");
  const queue = queueSession(values.session, context.env);
  const { promotion } = await onEnvironment("promote", values, context, (call, repositoryIdentity) =>
    call("banks.memory.promote", { ...(values.bank !== undefined && { bank: values.bank }), queue, repositoryIdentity }, { timeoutMs: PROMOTE_WAIT_MS }));
  if (promotion.state === "failed") {
    context.stderr(promotionLines(promotion));
    return 1;
  }
  context.stdout(promotionLines(promotion));
  return 0;
};

/** What the environment refused, for the caller: a validator refusal's findings first, and the writable banks to name one of. */
const refusalText = (refusal: LocalRefusal): string => {
  const invalid = ValidationFailedError.safeParse(refusal.error);
  if (invalid.success) return `${invalid.data.data.findings.map(bankFindingLine).join("")}${refusal.message}\n`;
  const unnamed = BankRequiredError.safeParse(refusal.error);
  if (unnamed.success) return `${refusal.message} The writable banks in scope: ${unnamed.data.data.banks.join(", ")}; name one with --bank.\n`;
  return `${refusal.message}\n`;
};

/** The `bank` verbs by name. */
const VERBS: Readonly<Record<string, (args: readonly string[], context: BankContext) => Promise<number>>> = { validate, search, read, draft, promote };

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
    context.stderr(error instanceof LocalRefusal ? refusalText(error) : `${error.message}\n`);
    return 1;
  }
};
