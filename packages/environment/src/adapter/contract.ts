import type {
  AccountIdentity,
  AdapterCapabilities,
  AttachmentKind,
  AttachmentRecord,
  AuthStatus,
  ContainmentLevel,
  ContainmentMechanism,
  CredentialSpec,
  DenylistMatch,
  InterruptCause,
  JsonObject,
  Mode,
  ModelUsage,
  ProcessHoldKind,
  PromptKind,
  PromptQuestion,
  RunError,
  RunSuggestion,
  RunSkillSet,
  RunSkillSetMember,
  TranscriptPayload,
  Workspace,
} from "@agent-harness/contracts";

/**
 * The adapter contract (claude-adapter spec, "The adapter contract"; ADR
 * 0015, ADR 0022): the in-process interface of live objects an adapter
 * implements for one provider. It never crosses the wire; what does is the
 * contracts package's (the capabilities descriptor, the credential spec, the
 * transcript vocabulary). The adapter host (`host.ts`) is its only caller and
 * the only consumer of a run's events, which it appends to the log through
 * the scoped append and nothing else.
 *
 * Every optional method pairs with a flag of the descriptor, and the host
 * refuses a call the flag does not cover (`capabilities.ts`): the
 * descriptor, not the presence of a method, is what a client is told.
 */

/** What an adapter can do: the contracts' capabilities descriptor, static for the adapter's life. */
export type AdapterDescriptor = AdapterCapabilities;

/**
 * How the adapter's credential is scoped (ADR 0018): the contracts' spec,
 * plus the parser from its status command's output to a sign-in state.
 */
export interface AdapterCredentialSpec extends CredentialSpec {
  parseStatus(output: string): AuthStatus;
}

/** An account as an adapter is handed it: its id, and its config directory (null for the provider's own default). */
export interface AccountRef {
  readonly id: string;
  readonly directory: string | null;
  /** The account's label, for what a person reads (a run's error naming the account); absent where the caller has none. */
  readonly label?: string;
}

/**
 * One model of an adapter's catalogue: its id, its family, an ordinal tier
 * the adapter supplies (higher is stronger) and the reasoning efforts it takes.
 */
export interface ModelOption {
  readonly id: string;
  readonly family: string;
  readonly tier: number;
  readonly efforts: readonly string[];
  readonly label?: string;
  /** Only a provider-reported denominator; static catalogues omit it. */
  readonly contextWindow?: number | null;
}

/** The models an account can use: listed live from the provider (`liveModels`), or the adapter's static list. */
export interface ModelCatalogue {
  readonly live: boolean;
  readonly models: readonly ModelOption[];
}

/** One plan window's use, as a usage reading reports it. */
export interface UsageWindow {
  readonly window: string;
  /** How much is used, 0 to 1 and beyond; null when the provider does not say. */
  readonly utilisation: number | null;
  readonly resetsAt: string | null;
  /** The latest rate-limit verdict a run reported for the window (`plan.limit`), folded in after the reading. */
  readonly verdict?: "allowed" | "warning" | "rejected";
}

/** Plan usage for an account (`planUsage`), with the identity a client pools it by (ADR 0005, ADR 0018). */
export interface UsageReading {
  readonly identity: AccountIdentity;
  readonly windows: readonly UsageWindow[];
  /** When the provider was read, as an ISO 8601 instant: what the environment's pool ages the reading by. */
  readonly readAt: string;
  /**
   * Why there are no windows, when the provider reported none: an API-key
   * login, a binary whose usage method was renamed, a read that failed. A
   * client degrades to absent-with-reason on it. Absent on a reading with windows.
   */
  readonly unavailableReason?: string;
}

/**
 * What a commands listing is resolved under, as its session's next run
 * would be (#503): whether the session's repository passed the trust gate
 * (its project settings, and its own commands, load), and the skill set
 * resolved for the session, which the adapter loads as a run would.
 */
export interface CommandsScope {
  readonly trusted: boolean;
  readonly skillSet: RunSkillSet;
}

/**
 * A slash command the provider offers an account in a workspace
 * (`commands`): its own, or its listing of a member of the skill set it was
 * handed, which the host folds into that member's skill entry (#503).
 */
export interface ProviderCommand {
  readonly name: string;
  readonly description: string;
  /** Whether it is the provider's own built-in, which a member's `/name` never shadows (skills spec, "Slash resolution"). */
  readonly builtin: boolean;
}

/**
 * A session the provider holds in an account's directory, as the listing
 * (`sessionListing`) answers it for Carry over (ADR 0021, #578): what the
 * provider's own session info says of it. The listing leaves out orphaned
 * and superseded transcripts, so every session here has a working
 * directory.
 */
export interface ProviderSessionInfo {
  readonly providerSessionId: string;
  /** The title the provider keeps for it: a person's rename, else one the provider generated; null for none. */
  readonly customTitle: string | null;
  /** The provider's one line for it (its summary); null for none. */
  readonly summary: string | null;
  /** The first prompt the SDK reports; for a continued Routine firing this is the person's later prompt (#756, David 2026-10-02). Null for none. */
  readonly firstPrompt: string | null;
  /** The directory the session ran in, as the transcript names it. */
  readonly workingDirectory: string;
  /** The tag the provider keeps on it (`archived`); null for none. */
  readonly tag: string | null;
  /** When it began, as an ISO 8601 instant; null when the transcript does not say. */
  readonly createdAt: string | null;
  /** When its transcript was last written, as an ISO 8601 instant. */
  readonly lastModified: string;
}

/**
 * The transcript types an imported session's history is mapped to (ADR
 * 0021, #579): what the provider recorded of its turns, the assistant's
 * words and its tool calls, a subagent's calls nested under the call that
 * started it, as a run of the harness would have reported them. A run's own
 * facts (its usage, plan limits, delegated work, the provider session it
 * linked) are not history.
 */
export const HISTORY_EVENT_TYPES = ["assistant.text", "assistant.thinking", "tool.started", "tool.ended"] as const satisfies readonly AdapterEventType[];

/** A user message of an imported session's history: its text and its attachments as the log records them; the environment mints its id. */
export interface HistoryMessage {
  readonly type: "message.sent";
  readonly payload: { readonly text: string; readonly attachments: readonly AttachmentRecord[] };
}

/**
 * One event of an imported session's history, in the order it happened, and
 * when, as the provider recorded it (null when it did not say): a user
 * message, or a transcript event of `HISTORY_EVENT_TYPES`.
 */
export type HistoryEvent = (HistoryMessage | Extract<TranscriptEvent, { readonly type: (typeof HISTORY_EVENT_TYPES)[number] }>) & { readonly at: string | null };

/** An attachment as a run is handed it: what it is, and its bytes, which never go in the log. */
export interface AttachmentData {
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/** A user message as a run is handed it, under the id the environment minted for it. */
export interface PromptMessage {
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentData[];
}

/**
 * What a run continues from: nothing, the provider's own session (`resume`),
 * a fork of another session's (`fork`, from a message when one is named), or
 * this session's rewound to a message (`rewind`).
 */
export type RunTarget =
  | { readonly kind: "fresh" }
  | { readonly kind: "resume"; readonly providerSessionId: string; /** Retained import transcript, never an authentication source. */ readonly sourceDirectory?: string }
  | { readonly kind: "fork"; readonly providerSessionId: string; readonly atMessageId: string | null }
  | { readonly kind: "rewind"; readonly providerSessionId: string; readonly toMessageId: string };

/**
 * A tool server the factory built for one run (memory tools, the browser, the
 * completions surface's client tools): a server the provider starts from
 * configuration of its own shape (`ConfiguredToolServer`), or tools served
 * in the environment's own process (`InProcessToolServer`).
 */
export type ToolServer = ConfiguredToolServer | InProcessToolServer;

/** A server the provider starts itself from its own configuration (Claude's MCP server config): opaque to the host. */
export interface ConfiguredToolServer {
  readonly name: string;
  readonly config: unknown;
}

/**
 * Tools the environment serves in its own process (#139): the adapter shows
 * each to the model under the server's name, hands the tool gate what each
 * call reaches as its tool declares (#540), and hands each call to `call`.
 * An adapter reports a call to one in its transcript under the name
 * `inProcessToolName` gives (`mcp__<server>__<tool>`, the name Claude's own
 * MCP servers go by), with the provider's id for the call, which it passes
 * to `call` as well. A session's runs share its provider process, so an
 * adapter may serve a later run with the server a process was started with
 * when its tools are the same (`inProcessToolKey`); a server built for one
 * session is never handed to another.
 */
export interface InProcessToolServer {
  readonly name: string;
  readonly tools: readonly HostTool[];
  /**
   * The tools run outside the environment (the completions surface's caller
   * runs its own): a call touches nothing here, so the adapter lets it go
   * ahead without a permission prompt, and several go out side by side.
   */
  readonly external: boolean;
}

/**
 * One tool of an in-process server: its name, what it does, the JSON Schema
 * of its input as the model sees it, what a call reaches, and what runs a
 * call.
 */
export interface HostTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  /**
   * What a call reaches, read from the call's input (browser spec, "The
   * tools"): the adapter hands the tool gate this in place of `other`, so
   * containment and the denylist rule on a browser verb's addresses and a
   * fetch reader's URLs as they rule on the provider's own. Absent, every
   * call is `other`, whose input the denylist reads string by string. It is
   * code, not something the model sees, so it is no part of the server's
   * key (`inProcessToolKey`).
   */
  readonly access?: (input: JsonObject) => HostToolAccess;
  /** Runs a call, resolving with what the model reads; it may take as long as the tool needs (a caller's tool is parked until the caller answers). */
  call(input: JsonObject, call: HostToolCall): Promise<HostToolResult>;
}

/**
 * What a call to an in-process tool may declare it reaches: `browse` with
 * the addresses a browser verb opens, `fetch` with the URLs a fetch reader
 * reads, or `other`.
 */
export type HostToolAccess = Extract<ToolAccess, { readonly kind: "browse" | "fetch" | "other" }>;

/** A call as the adapter hands it over: the provider's id for it (as the transcript's `tool.started` names it), and a signal aborted when the provider gives up on it. */
export interface HostToolCall {
  readonly toolCallId: string | null;
  readonly signal?: AbortSignal;
}

/** What a tool call answers the model: text, any images beside it (a screenshot), and whether it failed. */
export interface HostToolResult {
  readonly text: string;
  readonly isError: boolean;
  /** Images the model reads after the text, in order; absent or empty for a result of text alone. */
  readonly images?: readonly HostToolImage[];
}

/** An image a tool answers: its bytes and their media type (`image/jpeg`). */
export interface HostToolImage {
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/**
 * How the transcript records an image in a tool's result (claude-adapter
 * spec, #540's notes): its media type and its size in bytes, never the
 * bytes, which the model read and the log never holds, as an attachment's.
 */
export interface RecordedImage {
  readonly type: "image";
  readonly mediaType: string;
  readonly size: number;
}

export const recordedImage = (mediaType: string, size: number): RecordedImage => ({ type: "image", mediaType, size });

/** Whether a tool server is served in the environment's own process. */
export const isInProcess = (server: ToolServer): server is InProcessToolServer => "tools" in server;

/** The name an adapter reports a call to an in-process server's tool under in its transcript. */
export const inProcessToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/**
 * What a call named `toolName` reaches when it is one of `servers`'
 * in-process tools, as that tool declares it from the call's input (`other`
 * when it declares nothing); null when no in-process tool of `servers` goes
 * by that name, which leaves the call to the adapter's own reading.
 */
export const inProcessToolAccess = (servers: readonly ToolServer[], toolName: string, input: JsonObject): HostToolAccess | null => {
  for (const server of servers) {
    if (!isInProcess(server)) continue;
    const tool = server.tools.find((candidate) => inProcessToolName(server.name, candidate.name) === toolName);
    if (tool !== undefined) return tool.access?.(input) ?? { kind: "other" };
  }
  return null;
};

/**
 * What an in-process server shows the model, as one string: two servers with
 * the same key serve the same tools, so a process started with one can serve
 * a run handed the other.
 */
export const inProcessToolKey = (server: InProcessToolServer): string =>
  JSON.stringify([server.name, server.external, server.tools.map((tool) => [tool.name, tool.description, tool.inputSchema])]);

/**
 * What a run's tool servers show the model, as one string: an in-process
 * server by its key, another by its name. A provider process started with
 * servers of one key serves a later run handed servers of the same key with
 * the ones it started with; another key needs a fresh process.
 */
export const toolServersKey = (servers: readonly ToolServer[]): string => servers.map((server) => (isInProcess(server) ? inProcessToolKey(server) : server.name)).join("\n");

/**
 * A run's containment as its adapter enforces it (permissions spec,
 * "Containment": what each level means, and the enforcement for Claude):
 * the level `run.policy.resolved` recorded, never one the probe cannot
 * enforce, the mechanism the probe found, and the directories a run may
 * write in at a workspace level. The shell side is the provider's sandbox
 * (Claude's `sandbox` option, #140), set from these values; file tools,
 * fetch and search do not pass through it, so the tool gate
 * (`RunContext.gate`) denies them. At `off` nothing applies, and the
 * directories are named but not made. A session's runs share its provider
 * process, whose sandbox is fixed when it starts: an adapter whose process
 * was started under another level or mechanism stops it and starts one for
 * the run.
 */
export interface RunContainment {
  readonly level: ContainmentLevel;
  /** What enforces it: null at `off`. */
  readonly mechanism: ContainmentMechanism | null;
  /** The session's scratch directory: it lives with the session, removed when the session is purged. */
  readonly scratchDirectory: string;
  /** The temporary directory of the session's runs, the provider's `TMPDIR`: the session's, since its runs share one provider process. */
  readonly temporaryDirectory: string;
  /**
   * Where a run may write at a workspace level, as absolute paths: its workspace (always first), the scratch directory and its
   * temporary directory, then the repository's git directory when it lies outside the workspace (a worktree's common git
   * directory, the repository's `.git` above a directory below its root; #322), read as the run starts.
   */
  readonly writable: readonly string[];
  /**
   * What a run may not write or make though it lies in the writable set, as absolute paths (#791): at a workspace level, in
   * the git directory of the repository holding the workspace (the one `writable` ends with when it lies outside the workspace,
   * else the workspace's own `.git`), its `hooks`, its `config` and the per-worktree `config.worktree` (the main worktree's
   * beside `config`, each linked worktree's under `worktrees/<name>/`), there or not, since the user's own git runs what they
   * name outside containment; then the same in each submodule's git directory under its `modules` and in theirs in turn
   * (#933), as listed then; and each attached bank checkout (#1038), including one nested under the workspace.
   * Read as the run starts; empty at `off`.
   */
  readonly readOnly: readonly string[];
  /** Whether the model's commands and the provider's fetch and search tools may reach any host: false only at `workspace-no-network`. */
  readonly network: boolean;
}

/**
 * The denylist as a provider projects it onto its own deny rules on an
 * unattended run (permissions spec, "Provider deny rules where they must
 * apply"; #140): what a sandboxed command may not read, and the command
 * patterns the provider refuses by its own rules. Read when the run starts,
 * the enabled entries only. An attended run is handed none, so a person's
 * explicit allow of a denylisted call is never blocked by a provider rule.
 */
export interface RunDenylist {
  /** The path section's enabled entries, absolute: `~` read as the environment's home directory. */
  readonly paths: readonly string[];
  /** The directories the path section's entries leave out (the matcher's exemption): the containment directories and the scratch workspaces; a file among them (the launcher's service state, which git's credential helper reads, #705) is left out alone. */
  readonly exempt: readonly string[];
  /** The command-pattern section's enabled entries, as written. */
  readonly commandPatterns: readonly string[];
}

/**
 * What one spawn of a provider process, or one terminal's shell, is
 * supplied (#307): the variables to put into its environment, and their
 * release, which its stop calls (a secret minted for it disposed, a token
 * revoked). Neither is ever written to disk, to the log or into argv.
 * Beside them, the directories made for the holder alone that the tools
 * it is given write in (a key-manager CLI's configuration directory,
 * #1119): a contained run's commands may write them beside its writable
 * set, since the holder's release deletes them. None when absent.
 */
export interface SuppliedVariables {
  readonly variables: Readonly<Record<string, string>>;
  readonly writable?: readonly string[];
  release(): void;
}

/**
 * The process environment (forge spec, "Per provider process"; #307): the
 * variables the harness's services put into every provider process and
 * terminal the environment starts, without an adapter knowing what they
 * are. A provider process is the environment's, not a run's (ADR 0015), and
 * serves many runs with an environment fixed at spawn, so a run carries the
 * environment its process would be spawned with rather than the variables:
 * `key`, which names what they are and never holds a secret, empty when
 * nothing is supplied; and `supply`, which answers them. An adapter adds the
 * key to what its process was spawned with, so a run whose key differs from
 * its live process's is served by a fresh one, as for changed instructions;
 * it calls `supply` once per spawn, before the process starts, layers
 * the variables over its own scrubbed environment, and lets a contained
 * run's commands write the directories supplied as the holder's own
 * (#1119). The host releases them
 * as the pool stops the process, whatever stops it, or as the session's
 * next spawn replaces it; a release runs once, and an adapter need not call it.
 */
export interface ProcessEnvironment {
  readonly key: string;
  supply(): Promise<SuppliedVariables>;
}

/**
 * Everything a run needs, resolved by the host: the session and run, the
 * account's directory, the workspace and repository, model, effort and the
 * mode the policy resolver gave it, the composed instruction text, what it continues from, the
 * factory's tool servers, the trust decision, the process environment, the
 * skill set, and the prompt, which is the messages it starts with in order
 * (queued ones first).
 */
export interface RunInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly account: AccountRef;
  readonly workspace: Workspace;
  /** Bank checkouts attached for reading; file tools may not write them, and containment grants no write access. Changes require a fresh provider process. */
  readonly additionalDirectories?: readonly string[];
  readonly repositoryIdentity: string | null;
  readonly model: string;
  readonly effort: string | null;
  /** The run's effective mode (`run.policy.resolved`): the adapter maps it onto its provider. */
  readonly mode: Mode;
  /** The ceiling the run was resolved under: Claude sets `allowDangerouslySkipPermissions` only when it is bypassPermissions. */
  readonly ceiling: Mode;
  readonly instructions: string;
  readonly target: RunTarget;
  readonly toolServers: readonly ToolServer[];
  /**
   * Whether the repository passed the trust gate (ADR 0009): the trust
   * store's decision on its key, read as the run launched (#500); false for
   * an undecided or declined repository and a scratch workspace.
   */
  readonly trusted: boolean;
  /** The run's containment (`run.policy.resolved`): the adapter maps it onto its provider's sandbox. */
  readonly containment: RunContainment;
  /** The denylist to project onto the provider's own rules: set on an unattended run, null on an attended one (#140). */
  readonly denylist: RunDenylist | null;
  /** What the process that serves the run is given beside the provider's own environment (#307); its key empty, and nothing supplied, while no supplier is registered. */
  readonly processEnvironment: ProcessEnvironment;
  /**
   * The run's skill set (skills spec, "Materialisation and the Claude
   * mapping"; ADR 0009), resolved by the host as it launches: the
   * generation the adapter maps its own way, the fingerprint, every member,
   * and the native names to hide. A provider fixes its skills when its
   * process starts, so an adapter adds the fingerprint to what its process
   * was spawned with, and a run whose fingerprint differs from its live
   * process's is served by a fresh one, as for changed instructions (#138).
   * Empty, with no fingerprint, while nothing resolves one.
   */
  readonly skillSet: RunSkillSet;
  readonly prompt: readonly PromptMessage[];
}

/** The kinds of prompt a run parks on (conflict X1: the permissions workstream's names). */
export type { PromptKind };

/**
 * What a provider asks, mapped by its adapter onto the harness's fields
 * (permissions spec, "Prompts"), which the broker records on
 * `prompt.opened`. Every field is optional: the broker
 * records what is absent as null (a summary it derives from the rest).
 */
export interface PromptDetail {
  /** The tool the call is for. */
  readonly toolName?: string | null;
  /** The provider's id for the tool call. */
  readonly toolCallId?: string | null;
  /** The tool's input as the model gave it. */
  readonly input?: JsonObject | null;
  /** One line saying what is asked (Claude's permission title); derived from the rest when absent. */
  readonly summary?: string | null;
  /** The path that made the provider ask. */
  readonly blockedPath?: string | null;
  /** Why the provider asked, in its own words. */
  readonly reason?: string | null;
  /** A question prompt's questions. */
  readonly questions?: readonly PromptQuestion[] | null;
  /** A plan prompt's plan text. */
  readonly plan?: string | null;
  /** The provider's remember-suggestions, in its own terms: what an answer with `remember: 'session'` applies. */
  readonly suggestions?: readonly JsonObject[];
  /** The subagent that asked. */
  readonly agentId?: string | null;
  /** A denylist prompt's matches: each entry the call matched, the first the one it names (#132). */
  readonly denylist?: readonly DenylistMatch[] | null;
}

/** A permission prompt or question a run asks through the broker. */
export interface PromptRequest {
  readonly sessionId: string;
  readonly runId: string;
  /**
   * The prompt's id. An adapter that also takes answers through
   * `AdapterRun.answerPrompt` (its own permission table) names it here, so an
   * answer given there names the same prompt; otherwise the host mints one.
   * The broker always receives it, and records it as the prompt's id.
   */
  readonly promptId?: string;
  readonly kind: PromptKind;
  /** What the provider asks, on the harness's fields; the broker records it on `prompt.opened`. */
  readonly detail: PromptDetail;
  /**
   * Aborted when the provider cancels the request (the tool call became
   * moot, the turn was interrupted): the adapter has answered it itself, so
   * the host counts the prompt answered, once, and at once when it had
   * aborted before the request was made, and the broker closes it
   * (`cancelled`) unless its run's end closes it first.
   */
  readonly signal?: AbortSignal;
}

/**
 * What an adapter's `answerPrompt` throws when the answer cannot reach a
 * tool call: `run_ended`, the run the prompt belongs to has ended (the call
 * is denied, never allowed), or `not_open`, the adapter has no such prompt
 * open. The host refuses the answer `conflict` with the reason, so whoever
 * answered can say so (#130).
 */
export class PromptClosed extends Error {
  constructor(
    message: string,
    readonly reason: "run_ended" | "not_open",
  ) {
    super(message);
    this.name = "PromptClosed";
  }
}

/**
 * What an adapter's `withdraw` throws when its provider has no way to take a
 * queued message back (Claude's CLI without the cancel-by-id control): the
 * host refuses the withdraw `invalid_params`, reason `unsupported`, so a
 * client draws the verb dim with the reason (ADR 0022), rather than
 * answering as if the provider had read the message (#228).
 */
export class WithdrawUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WithdrawUnsupported";
  }
}

/**
 * The answer to a prompt: allowed or denied, with a message for the model,
 * and what a person's answer may carry beside (`permissions.prompts.answer`):
 * a question's answers keyed by the question's text, the tool's input as
 * edited, an approved plan's mode to continue in (already clamped to the
 * run's ceiling), and `remember: 'session'` on an allowed permission prompt,
 * which the adapter applies through the provider's own session rules.
 */
export interface PromptDecision {
  readonly decision: "allow" | "deny";
  readonly message?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly updatedInput?: JsonObject;
  readonly mode?: Mode;
  readonly remember?: "session";
}

/**
 * Where a run's prompts go (claude-adapter spec, "The permission broker";
 * permissions spec, the broker): the one place a provider's prompt or
 * question lands. The host hands each run the environment's broker
 * (`host.ts`), which records the prompt as `prompt.opened`, parks the run,
 * and settles the request with the answer a person gives
 * (`permissions.prompts.answer`), or, when the run ends, with a denial.
 *
 * The host counts a run parked from a request until that prompt is
 * answered: when the request settles, or when the host hands a person's
 * answer to the run's `answerPrompt` (`AdapterHost.deliverAnswer`, which
 * settles the request too), whichever comes first.
 */
export interface PermissionBroker {
  request(request: PromptRequest): Promise<PromptDecision>;
}

/**
 * What a tool call does, as its adapter describes it to the tool gate, in
 * the provider's terms mapped onto the harness's: reading or writing files
 * (their paths, absolute or relative to the workspace, `~` for the home
 * directory), a shell command, fetching URLs, a web search (its query, and
 * the domains it is limited to when it names any), a browser verb opening
 * addresses, or anything else (a question, a tool server's call its tool
 * declares nothing of). The gate rules on this, never on the provider's
 * tool names; for `other` the denylist reads the call's input. A call to
 * an in-process tool is what that tool declares (`HostTool.access`, #540).
 */
export type ToolAccess =
  | { readonly kind: "read"; readonly paths: readonly string[] }
  | { readonly kind: "write"; readonly paths: readonly string[] }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "fetch"; readonly urls: readonly string[] }
  | { readonly kind: "search"; readonly query: string; readonly domains?: readonly string[] }
  | {
      readonly kind: "browse";
      readonly urls: readonly string[];
      /** A frame's match under the browser's own environment policy. */
      readonly match?: DenylistMatch;
      readonly frame?: "top-level" | "sub-frame";
      readonly environmentId?: string;
    }
  | { readonly kind: "other" };

/**
 * One tool call the gate is asked about: the provider's id and name for it,
 * a one-line summary for people, what it does, and the tool's input as the
 * model gave it, which a prompt about the call records and the denylist
 * reads for a call of kind `other` (what the harness's own tool servers
 * receive).
 */
export interface GatedToolCall {
  /** The adapter verified this call belongs to an in-process server whose tools run outside the environment. */
  readonly external?: boolean;
  readonly toolCallId: string;
  readonly tool: string;
  readonly summary: string;
  readonly access: ToolAccess;
  readonly input?: JsonObject;
}

/** Longest summary the gate records, in characters: longer is cut, with an ellipsis. */
const SUMMARY_MAX = 200;

/** `text`'s first line, cut to `SUMMARY_MAX`. */
const oneLine = (text: string): string => {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
};

/** What a call names, as its summary gives it: its paths, its command, its URLs or addresses, or its query. */
const namedBy = (access: ToolAccess): string => {
  switch (access.kind) {
    case "read":
    case "write":
      return access.paths.join(", ");
    case "shell":
      return access.command;
    case "fetch":
    case "browse":
      return access.urls.join(", ");
    case "search":
      return access.query;
    case "other":
      return "";
  }
};

/**
 * A gated call's one-line summary for people: the call's title when the
 * provider gives one, else the tool and what the call names (a declared
 * browser verb's or fetch's address among them), cut to a line of at most
 * 200 characters.
 */
export const toolCallSummary = (tool: string, access: ToolAccess, title?: string): string =>
  title !== undefined && title.trim() !== "" ? oneLine(title.trim()) : oneLine(`${tool} ${namedBy(access)}`);

/**
 * The gate's ruling. `allow` hands the call on to the provider's own
 * evaluation (its mode, its rules, its prompts), which the gate never
 * replaces; `deny` is final. `message` is what the model is told, including
 * a person's Note on an allowed denylist prompt.
 */
export type GateDecision = { readonly decision: "allow"; readonly message?: string } | { readonly decision: "deny"; readonly message: string };

/**
 * The tool gate (permissions spec, "Modules": the tool gate): consulted by
 * every adapter before the provider's own evaluation, for every tool call in
 * every mode, bypass included. It applies containment as a hard deny (#133:
 * no prompt, the model told why, recorded as `tool.decision` by
 * `containment`; widening containment is a settings change, never an answer
 * to a prompt), then hands a denylist match to the broker as a `denylist`
 * prompt (#132): parked for the person on an attended run, whose explicit
 * allow lets that one call on, denied at once on an unattended one. For
 * Claude it is asked from the SDK's `PreToolUse` hook, which the CLI runs
 * before its own evaluation of every call (#140), and from `canUseTool` for
 * what the hook did not let through as it is: the sandbox's ask for a host,
 * which no hook sees, and a call another hook rewrote since; the fake
 * adapter asks it for every call it plays.
 */
export interface ToolGate {
  /**
   * Rules on a call. `signal` aborts when the provider gives up on the call
   * (it cancelled the tool use, or its hook timed out): a prompt the gate
   * parked for it is closed (`cancelled`) and the call denied, so nobody is
   * left answering for a call that will never run.
   */
  check(call: GatedToolCall, signal?: AbortSignal): Promise<GateDecision>;
}

/**
 * One call of a file tool its adapter recognises (Claude's `Edit`,
 * `MultiEdit`, `Write` and `NotebookEdit`), as the file-change observer is
 * told of it: the provider's id for the call, its tool, the paths it writes
 * as its input names them, and the provider's working directory at the call,
 * which a relative one is read against.
 */
export interface FileToolCall {
  readonly toolCallId: string;
  readonly tool: string;
  readonly paths: readonly string[];
  readonly cwd: string;
}

/**
 * The environment's observer of a run's recognised file tools (switch-over
 * spec, "File undo"; #1182), which keeps what they change. The adapter asks
 * `before` once the tool gate has let a call through, and the provider does
 * not run the call until it settles; then tells `completed` once the call
 * succeeded, or `failed` once it failed, was interrupted, ran on other paths
 * than it was announced with, or was given up on. Every call announced to
 * `before` ends at most once, always with the same `FileToolCall`, on the
 * observer that was told of it. A call the provider refuses after the gate
 * (its rules, its mode, a person's answer) has no end of its own: it is told
 * `failed` once the adapter gives up on it, as its process ends or too many
 * later calls wait (Claude keeps 1024). `before` rejecting never stops the
 * call: it goes on, and ends as any other. Nothing else is observed: a
 * denied call, another tool's, a shell command's writes. The observer decides
 * nothing about a call.
 */
export interface FileChangeObserver {
  /** Before the call writes; `signal` aborts when the provider gives up on the call. */
  before(call: FileToolCall, signal: AbortSignal): Promise<void>;
  /** The call succeeded; `signal` aborts when the provider stops waiting. */
  completed(call: FileToolCall, signal: AbortSignal): Promise<void>;
  failed(call: FileToolCall): void;
}

/** The types a run's events may be: the transcript types an adapter produces. The run's start and end, and the messages sent to it, are the host's. */
export const ADAPTER_EVENT_TYPES = [
  "run.suggested",
  "message.delivered",
  "assistant.delta",
  "assistant.text",
  "assistant.thinking",
  "tool.started",
  "tool.updated",
  "tool.ended",
  "command.ran",
  "tasks.changed",
  "usage.reported",
  "context.reported",
  "plan.limit",
  "session.provider-linked",
] as const;
export type AdapterEventType = (typeof ADAPTER_EVENT_TYPES)[number];

/** One transcript event of a run as its adapter reports it: its type and payload, the run's id left for the scoped append to stamp. */
export type TranscriptEvent = {
  readonly [T in AdapterEventType]: { readonly type: T; readonly payload: Omit<TranscriptPayload<T>, "runId"> };
}[AdapterEventType];

/**
 * How a run ended, as its adapter reports it: the last event of its stream.
 * The host records it as `run.ended`, with the duration on its own clock;
 * `disposed` and `drained` are the host's, never an adapter's.
 */
export interface RunEnd {
  readonly type: "end";
  readonly reason: "completed" | "error" | "interrupted";
  readonly cause?: InterruptCause | null;
  readonly error?: RunError | null;
  readonly usage?: readonly ModelUsage[] | null;
  readonly turnCount?: number | null;
  readonly resultText?: string | null;
}

/**
 * The provider's report of a tool call it denied itself, without asking the
 * broker (permissions spec, "Events": rule denials come from the provider's
 * own denial report): one of its rules, its classifier, its mode, or
 * another reason of its own. Not a transcript event: the host records it as
 * the call's `tool.decision` (#131), unless the call has one already.
 */
export interface ToolDenial {
  readonly type: "denial";
  readonly toolCallId: string;
  readonly toolName: string | null;
  readonly by: "rule" | "classifier" | "mode" | "provider";
  /** The provider's reason, in its own words; null when it gives none. */
  readonly reason: string | null;
}

/** What a run's event stream yields: transcript events and the provider's denial reports, then one end. */
export type AdapterEvent = TranscriptEvent | ToolDenial | RunEnd;

/**
 * One run, live. Its `events` are consumed once, by the host, and losslessly:
 * every event yielded before the end is appended, in order. The stream ends
 * with exactly one `end`; the host makes sure of it on every path (the
 * adapter throws, the stream stops without an end, the host disposes the
 * run), appending the one `run.ended` itself when the adapter could not.
 *
 * The promises `send`, `interrupt` and `withdraw` answer must settle in a
 * bounded time, once the provider has taken, refused or answered, whether or
 * not the run has ended meanwhile, and never wait on a later turn (a send
 * that resolved only when a turn read the message would wait on a run nobody
 * can start yet). An answer that comes after the run's end can hand a message
 * back to the environment's queue, so the host tracks each until it settles
 * and a rewind waits on them (`sessions.rewind`, #245), for at most
 * `REWIND_WAIT_MS`, holding up its client's later commands meanwhile. Claude
 * resolves a send at once and bounds the others by its interrupt and control
 * timeouts.
 */
export interface AdapterRun {
  readonly events: AsyncIterable<AdapterEvent>;
  /**
   * Hands the provider a message sent during the turn (`providerQueue`),
   * under its id: the provider steers it into the turn (`steering`) or reads
   * it when the turn ends, reported by `message.delivered`.
   */
  send(message: PromptMessage): void | Promise<void>;
  /**
   * Interrupts the turn with cancel: the stream then ends `interrupted`, and
   * the answer names the messages the provider still held, which the host
   * takes back into the environment's queue (ADR 0022).
   */
  interrupt(): Promise<{ readonly stillQueued: readonly string[] }>;
  /**
   * Takes back one message the provider holds in its queue, by the id it was
   * handed under (`withdraw`; Claude's cancel-by-id control, ADR 0022):
   * `withdrawn` when the provider cancelled it, so no turn will read it;
   * false when the provider no longer holds it, having read it (or never
   * had it). The host calls it only for a message the log says the provider
   * holds, on the session's live run, since a provider's queue is the
   * session's, and takes a withdrawn message back into the environment's
   * queue at once. Asked again for a message it cancelled, or whose cancel it
   * sent without hearing back, it answers withdrawn, unless a turn has since
   * been seen reading it. It throws `WithdrawUnsupported` when the provider
   * has no way to take a message back, and anything else when it cannot say.
   */
  withdraw?(messageId: string): Promise<{ readonly withdrawn: boolean }>;
  /**
   * Answers a parked prompt (`interactivePrompts`); throws `PromptClosed`
   * when the answer can reach no tool call. An adapter denies its run's
   * parked prompts itself as the run ends, however it ends: once a run is no
   * longer live the host refuses answers `run_ended` without asking it.
   */
  answerPrompt?(promptId: string, decision: PromptDecision): void | Promise<void>;
  /** Stops one piece of delegated work (`subagents`). */
  stopTask?(taskId: string): void | Promise<void>;
  /**
   * Changes the running run's mode (`modeChange`; Claude's mode setter):
   * what `permissions.mode.set` asked for, already clamped to the run's
   * ceiling and the account's modes. The run's resolved policy stays as it was recorded.
   */
  setMode?(mode: Mode): void | Promise<void>;
  /**
   * Stops the run now: the host has ended it already (`disposed`, `drained`,
   * and every end of its own), and appends nothing more of it. The pool then
   * stops the session's process too (`Adapter.stopProcess`), so the next run
   * starts cold.
   */
  dispose(): void | Promise<void>;
  /**
   * The host is done with a run its adapter ended: the adapter keeps the
   * session's provider process for the next run, until the pool stops it
   * (`Adapter.stopProcess`).
   */
  release(): void;
}

/** A turn the provider opened on its own: a run the host adopts into the same session, and the queued messages it opened with. */
export interface ProviderTurn extends AdapterRun {
  readonly messageIds: readonly string[];
  /**
   * Tells the turn the run id the host adopted it under, once the run is
   * registered and before its events are read, so what it asks the broker
   * names its run and parks it; a turn the host lets go is never told one.
   */
  onAdopted?(runId: string): void;
}

/**
 * The port through which an adapter tells the pool (`pool.ts`) what holds
 * the session's provider process from its idle stop (the retention rule): a
 * live background task or a schedule registered in the session,
 * each under its id. A hold outlives the run that took it: the port stays
 * valid for the life of the process it was handed with, and does nothing
 * once that process has stopped. Holding what is held already, or letting
 * go what is not, changes nothing.
 */
export interface ProcessPort {
  /** Held work under a non-empty id; an empty id is logged and ignored. */
  hold(kind: ProcessHoldKind, id: string): void;
  unhold(kind: ProcessHoldKind, id: string): void;
  /**
   * The process exited on its own (its transport failed, the provider quit):
   * the pool records it stopped, reason `exited`, calls no `stopProcess`, and
   * the session's next run starts cold. A run live on it is its adapter's to
   * end, as its stream fails.
   */
  exited(): void;
}

/** What the host hands a run beside its input. */
export interface RunContext {
  /**
   * Where the run's prompts go: the environment's broker, which records
   * each as `prompt.opened` on the session's stream and parks the run while
   * it is unanswered.
   */
  readonly broker: PermissionBroker;
  /**
   * The tool gate, asked before the provider's own evaluation for every tool
   * call; a turn the provider opened on its own asks through the gate of the
   * run it followed, which rules under the run live then.
   */
  readonly gate: ToolGate;
  /** Held work on the session's provider process (the pool's port). */
  readonly process: ProcessPort;
  /**
   * The observer of the run's recognised file tools, when the environment
   * keeps what they change; a turn the provider opened on its own is
   * observed by the observer of the run it followed, as it is gated.
   */
  readonly fileChanges?: FileChangeObserver;
  /**
   * Who the provider says the run is signed in as (Claude's `accountInfo`),
   * when it says: the account store checks it against the identity it holds
   * for the run's account, and a mismatch is an `account.updated` notice with
   * a warning, and a fresh status read (#134). The host's never throws: a
   * failed check is logged.
   */
  reportIdentity(identity: AccountIdentity): void;
  /** A prediction delivered after the turn's end, while the process keeps reading. The host accepts only its latest completed run. */
  reportSuggestion?(suggestion: RunSuggestion): void;
  /**
   * The provider found the run's account unable to sign in (Claude: the
   * refresh of an expired login before a cold resume failed, #229): the
   * account store reads its status again at once, so the account pickers
   * show what the provider says of it now. The host's never throws.
   */
  recheckAccount(): void;
  /**
   * The adoption hook: a turn the provider opened on its own is reported
   * here, and the host registers it as a run of the same session once the
   * run it followed has ended.
   */
  adopt(turn: ProviderTurn): void;
}

/**
 * An adapter: one provider behind the contract. `createRun` answers at once
 * with the live run; any start-up it needs happens behind its event stream.
 * `status` is the probe the account store reads each account's sign-in
 * state and identity with, and the machine's own directory
 * (`ambientDirectory`) before it is adopted; `models` the catalogue a run's
 * model is validated against.
 *
 * The provider process a session's runs share is the environment's to start
 * and stop (ADR 0015), through the pool: `createRun` starts the session's
 * process when it has none and reuses it otherwise; `stopProcess` stops it.
 * The pool never runs two runs of one session at once, and pre-warms
 * nothing: after a stop, the next `createRun` starts cold.
 */
export interface Adapter {
  readonly descriptor: AdapterDescriptor;
  readonly credentials: AdapterCredentialSpec;
  /** A caller deadline or shutdown aborts the probe; reclaim provider processes and reject with the signal reason. */
  status(account: AccountRef, signal?: AbortSignal): Promise<AuthStatus>;
  /** Read cached identity metadata only: no sign-in, credential refresh, process launch or writes. Internal import planning, not a wire capability. */
  observeIdentity?(directory: string): Promise<AccountIdentity | null>;
  /**
   * The machine's own config directory for this provider (Claude's
   * `CLAUDE_CONFIG_DIR`, else `~/.claude`), which `accounts.adopt` registers
   * in place; absent, or null, when the provider has none here.
   */
  ambientDirectory?(): string | null;
  /** A cancelled listing must reclaim its query and propagate the signal reason without a fallback diagnostic. */
  models(account: AccountRef, signal?: AbortSignal): Promise<ModelCatalogue>;
  createRun(input: RunInput, context: RunContext): AdapterRun;
  /**
   * Stops the session's provider process, whichever it holds at the call; a
   * `createRun` after the call starts a new one. Idempotent: a session with
   * no process is a no-op. Resolves once the process has stopped. With
   * `kill`, the environment is closing and a stop has taken too long: the
   * process is killed at once, and the answer is not waited for.
   */
  stopProcess(sessionId: string, options?: { readonly kill?: boolean }): void | Promise<void>;
  /**
   * Plan usage per window, with the account's identity (`planUsage`). The
   * environment's pool (`accounts/usage-pool.ts`, #136) is its one caller:
   * concurrent asks for an account share one read, and none is made while
   * the pool holds a reading under six minutes old by its `readAt` (a read
   * that threw is asked again at the next ask). A read the pool gave up on
   * at its timeout may still be running when the next ask starts another,
   * so two can overlap. An adapter may keep readings of its own, but
   * `readAt` must stay when the provider was read, not when the reading was
   * handed over, since the pool ages by it.
   */
  usage?(account: AccountRef): Promise<UsageReading>;
  /**
   * The slash commands for an account and workspace, spending no tokens
   * (`commands`): what a run there would offer, under the scope the host
   * resolved for it, the provider's listing of each member of the set
   * among them, under its invocation text.
   */
  commands?(account: AccountRef, workspace: Workspace, scope: CommandsScope): Promise<readonly ProviderCommand[]>;
  /**
   * The text that invokes a member of a run's skill set, which slash
   * resolution hands the adapter in place of `/<name>` (skills spec, "Slash
   * resolution"; ADR 0009: `/name` is provider-neutral). Claude's is
   * `/agent-harness:<name>` for a member the generation links, `/<name>`
   * for a native one.
   */
  invocationText(member: Pick<RunSkillSetMember, "name" | "native">): string;
  /**
   * The sessions the provider holds in the account's directory, every
   * project of it (`sessionListing`): what Carry over imports (ADR 0021,
   * #578). Reads, and never creates, links or deletes anything there.
   */
  listSessions?(account: AccountRef): Promise<readonly ProviderSessionInfo[]>;
  /**
   * A listed session's history as the account's directory holds it
   * (`sessionListing`): its transcript and its subagent transcripts mapped
   * to the transcript vocabulary, oldest first (`HistoryEvent`); null when
   * the directory holds no transcript of it any more. What the first open of
   * an imported session appends to the log (ADR 0021, #579). Reads, and
   * never creates, links or deletes anything there.
   */
  readHistory?(account: AccountRef, providerSessionId: string): Promise<readonly HistoryEvent[] | null>;
  /**
   * Copies an imported provider conversation from its original directory into
   * the store under the harness session before a fork copies that session's
   * rows. Reads sourceDirectory when supplied, otherwise the Account directory; never authenticates there.
   * An explicit retained source must hydrate successfully; does nothing when already stored.
   * Absent for adapters that keep their own conversations without this store.
   */
  seedSessionStore?(account: AccountRef, sessionId: string, providerSessionId: string, sourceDirectory?: string): Promise<void>;
  /**
   * Whether a fork or rewind can continue stored history before this
   * message. Read before the command's transaction; absent for adapters
   * whose history is decided from the session's visible messages alone.
   */
  hasHistoryBefore?(account: AccountRef, sessionId: string, providerSessionId: string, messageId: string): Promise<boolean>;
  /**
   * The title the provider generated for a session (`titleRead`), or null for
   * none yet: its own summary, never the title field `writeTitle` mirrors a
   * user title into, so a mirrored title is never read back. The host reads
   * it after each run of the session ends and records it as the generated
   * title (source `provider`) unless the user has set one (`sessions/titles.ts`).
   */
  readTitle?(sessionId: string): Promise<string | null>;
  /**
   * Mirrors a user title into the provider's own title field (`titleWrite`):
   * the host calls it once a `session.title-set` with a title has committed
   * on a session that has run through this adapter, best effort (a failure
   * is logged), and never reads it back. A title cleared to null is not mirrored. No member of the contract writes the
   * provider's tag field: organisation never depends on what a provider can hold.
   */
  writeTitle?(sessionId: string, title: string): Promise<void>;
  /** A subagent's own transcript, read on demand (`subagentTranscripts`). */
  subagentTranscript?(sessionId: string, agentId: string): Promise<readonly JsonObject[]>;
  /**
   * Deletes the provider's transcript of a session (`transcriptDelete`):
   * synchronous, irreversible and idempotent, since it runs inside the
   * purge's transaction (`sessions/deletion.ts`, `ProviderTranscripts`).
   * `accounts` are the accounts the session's runs went through that the
   * environment still holds and owns: where the provider may have kept it.
   * An adopted account's directory is never handed over (ADR 0018: only the
   * provider's own CLI touches it); the purge records the copy there kept.
   */
  deleteTranscript?(sessionId: string, accounts: readonly AccountRef[]): undefined;
}
