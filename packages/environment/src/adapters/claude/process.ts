import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  getSessionMessages as sdkGetSessionMessages,
  importSessionToStore as sdkImportSessionToStore,
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, Mode, PromptQuestion } from "@agent-harness/contracts";
import { SANDBOX_NETWORK_TOOL, claudeGatedCall } from "./gate-access.js";
import {
  PromptClosed,
  WithdrawUnsupported,
  toolServersKey,
  type PromptDecision,
  type PromptDetail,
  type PromptKind,
  type PromptMessage,
  type RunContext,
  type RunEnd,
  type RunInput,
  type ToolServer,
} from "../../adapter/contract.js";
import type { Clock, Timer } from "../../serve/clock.js";
import { AsyncQueue } from "./async-queue.js";
import type { ConfigDirQueue } from "./config-dir-queue.js";
import { CLAUDE_PROVIDER, type HostEnvironment } from "./credentials.js";
import { FileToolObservation } from "./file-tools.js";
import { readStoredSession, resolveForkPoint, resolveRewindPoint, storedHolds, type ClaudeSessionStore } from "./history.js";
import { seedStoreFromDirectory } from "./imported-history.js";
import { LOGIN_EXPIRED_CODE, LoginLapsed } from "./login-refresh.js";
import { readRateLimit, toJson } from "./mapper.js";
import { buildRunOptions, claudeEffort, claudeMode, type ClaudeMode, type ResumePoint } from "./options.js";
import type { PlanLimitVerdict } from "./plan-usage.js";
import { SpendMeter } from "./spend.js";
import { TaskLedger } from "./tasks.js";
import { mapSdkMessage } from "./mapper.js";
import { ClaudeTurn, type TurnControl } from "./turn.js";
import { worktreeCheckout } from "./workspace.js";

/**
 * The Claude process (claude-adapter spec, "Environment-owned provider
 * processes" and "The Claude adapter": the prompt pump, permission table,
 * task ledger and settle grace, moved out of the run into the process).
 * `query()` takes its streaming input once and answers one
 * `Query`, so the input, the transport, the abort controller and the
 * `canUseTool` callback are fixed at spawn and belong to the process; a turn
 * (`turn.ts`) is one run. The process serves turns one at a time, as the CLI
 * does, and outlives them: the next run of the conversation attaches to it
 * when it can (same account, same trust, same tool servers, same process
 * environment key, same skill set, the provider session the run resumes), and a turn the
 * provider opens on its own, a settled background task answered or a
 * queued message read, is a new turn handed to the host's adoption hook.
 *
 * Whose turn the CLI has opened is read from the stream, not assumed: the
 * pinned CLI narrates (`msg_lifecycle_v1` on `init`) and stamps a turn's
 * first reply with the uuids of the prompts it consumed
 * (`user_message_uuid(s)`), and a prompt is stamped with the harness's
 * message id, so an `init` is held until a message names its owner. A turn
 * naming a waiting run's prompt is that run's; any other is the provider's
 * own, adopted, and the waiting run keeps waiting behind it, except a
 * delivery failure the SDK leaves unnamed, which is the one waiting run's
 * when nothing else is owed. A run the CLI never opens is ended by a
 * watchdog. A CLI that does not narrate falls back on a simpler rule: a
 * waiting run's prompt opens the next turn.
 *
 * The pool (`adapter/pool.ts`, #120) decides when it stops: `release()`
 * keeps it for the next run, `stopProcess` stops it (or kills its child at
 * once), and what holds it from the pool's idle stop is told through the
 * run context's `process` port (the retention rule): a `task` hold per
 * live background task, by the provider's task id, and one `schedule` hold,
 * under a synthetic id, while a cron job or a wakeup is registered. A
 * process that dies on its own tells the port it `exited`.
 */

/** What a process needs from its adapter. */
export interface ProcessDeps {
  readonly clock: Clock;
  /** The adapter's copy of the environment, taken once. */
  readonly hostEnv: HostEnvironment;
  /** An account's config directory, resolved: the ambient default for an account with none. */
  readonly configDirectory: (account: RunInput["account"]) => string;
  readonly executablePath: () => string | null;
  readonly sessionStore: ClaudeSessionStore | null;
  readonly autoMemoryDirectory: (input: RunInput) => string | null;
  readonly queue: ConfigDirQueue;
  /**
   * Has the CLI refresh the account's login in its own directory before a
   * cold resume through the store, whose temporary config directory holds no
   * refresh token (#229); rejects with `LoginLapsed` when the login failed.
   */
  readonly freshLogin: (account: RunInput["account"]) => Promise<void>;
  readonly timings: ProcessTimings;
  readonly diagnostic: (message: string, detail?: unknown) => void;
  /** A run reported a rate-limit verdict for the account: the plan-usage read folds it in. */
  readonly onRateLimit: (verdict: PlanLimitVerdict) => void;
  /**
   * The transport is gone: the adapter forgets the process, if it is still
   * the session's. Called on every close, so more than once for one process
   * (a dispose, then its pump's end; a forced interrupt, then the same):
   * forgetting only the process named keeps a replacement from being lost.
   */
  readonly onClosed: (process: ClaudeProcess) => void;
}

export interface ProcessTimings {
  /** How long a settled background task holds the process for the provider's turn about it (2 s). */
  readonly settleGraceMs: number;
  /** How long an interrupt waits for the control channel before the transport is forced down (8 s). */
  readonly interruptTimeoutMs: number;
  /** How long a prompt waits for the pump to learn whose turn the CLI opened (500 ms). */
  readonly decisionSettleMs: number;
  /** How long a model, mode or effort change on a kept process may take before the run fails. */
  readonly controlTimeoutMs: number;
  /** How long a run's prompt may sit unopened while the CLI serves no turn before the run ends error. */
  readonly openTimeoutMs: number;
}

/**
 * The tools that leave a job in the process that only fires while it idles
 * (a fixed list): a process holding one is kept. Each is counted when its
 * call ends `ok`, never when it starts, since a call may still be denied or
 * fail: a cron job until `CronDelete` removes one; a wakeup until a turn of
 * the provider's own opens with no message behind it, which is the wakeup
 * firing.
 */
const CRON_CREATE = "CronCreate";
/** The one schedule hold's id: the port holds a schedule while any is registered. */
export const SCHEDULE_HOLD_ID = "claude-schedules";
const CRON_DELETE = "CronDelete";
const WAKEUP = "ScheduleWakeup";

/** The tools whose prompt is a question or a plan rather than a permission (the permissions spec's kinds). */
const PROMPT_KINDS: Readonly<Record<string, PromptKind>> = { AskUserQuestion: "question", ExitPlanMode: "plan" };

export const DISPOSED_DENY_MESSAGE = "The run was stopped before this could be answered.";
export const ABORTED_DENY_MESSAGE = "The provider aborted this tool call.";
export const ENDED_DENY_MESSAGE = "The run this tool call belonged to has ended.";
const DEFAULT_DENY_MESSAGE = "The request was denied.";

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => value !== null && typeof value === "object" && !Array.isArray(value);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How many tool calls the hook let through the process remembers, so the provider's prompt about one is not gated again. */
const HOOK_GATED_KEPT = 1024;

/** The hook's answer for a call the gate denied: the CLI does not run it, and the model reads `message`. */
const gateDenial = (message: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message },
});

/** What the model reads when the gate could not rule on a call: the call is denied, since a hook that fails lets the CLI run it. */
const gateFailed = (error: unknown): string =>
  `Denied: this call could not be checked against the harness's rules (${describe(error)}), so it was not run. Continue without it and say what you could not do.`;

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * `AskUserQuestion`'s questions (the pinned SDK's `AskUserQuestionInput`) as
 * the harness records them, read tolerantly: a question without its text is
 * left out, and a missing header, description or flag is empty or false.
 */
export const questionsOf = (input: Record<string, unknown>): PromptQuestion[] => {
  const questions = Array.isArray(input["questions"]) ? (input["questions"] as unknown[]) : [];
  return questions.flatMap((entry): PromptQuestion[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const question = textOf(raw["question"]);
    if (question === null) return [];
    const options = (Array.isArray(raw["options"]) ? (raw["options"] as unknown[]) : []).flatMap((option) => {
      const fields = typeof option === "object" && option !== null ? (option as Record<string, unknown>) : {};
      const label = textOf(fields["label"]);
      return label === null ? [] : [{ label, description: typeof fields["description"] === "string" ? fields["description"] : "" }];
    });
    return [{ header: typeof raw["header"] === "string" ? raw["header"] : "", question, options, multiSelect: raw["multiSelect"] === true }];
  });
};

/**
 * What an allowed prompt hands the CLI (permissions spec, the Claude
 * mapping): the input as edited, with a question's answers under `answers`
 * as `AskUserQuestion` reads them; an approved plan's mode through a
 * `setMode` for the session; and `remember: 'session'` as the CLI's own
 * suggestions for the session (or, with none, an allow rule for the tool),
 * never written to a settings file.
 */
export const allowedResult = (
  toolName: string,
  input: Record<string, unknown>,
  decision: PromptDecision,
  suggestions: readonly PermissionUpdate[],
  toolUseID: string,
): PermissionResult => {
  const edited = decision.updatedInput ?? input;
  const updatedInput = decision.answers === undefined ? edited : { ...edited, answers: { ...decision.answers } };
  const updatedPermissions: PermissionUpdate[] = [];
  if (decision.mode !== undefined) updatedPermissions.push({ type: "setMode", mode: decision.mode, destination: "session" });
  if (decision.remember === "session") {
    updatedPermissions.push(
      ...(suggestions.length > 0
        ? suggestions.map((suggestion): PermissionUpdate => ({ ...suggestion, destination: "session" }))
        : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" } satisfies PermissionUpdate]),
    );
  }
  return { behavior: "allow", updatedInput, ...(updatedPermissions.length > 0 && { updatedPermissions }), toolUseID };
};

/** The user messages a provider message says it answers: the prompts its turn consumed, a narrated command starting, an echoed prompt. */
const ownersOf = (message: unknown): string[] => {
  if (!isRecord(message)) return [];
  const owners: string[] = [];
  if (Array.isArray(message["user_message_uuids"])) for (const one of message["user_message_uuids"]) if (typeof one === "string") owners.push(one);
  if (typeof message["user_message_uuid"] === "string" && !owners.includes(message["user_message_uuid"])) owners.push(message["user_message_uuid"]);
  if (message["type"] === "command_lifecycle" && message["state"] === "started" && typeof message["command_uuid"] === "string") owners.push(message["command_uuid"]);
  if (message["type"] === "user" && typeof message["uuid"] === "string" && message["parent_tool_use_id"] == null && message["isReplay"] !== true && message["isSynthetic"] !== true) {
    const body = message["message"];
    const content = isRecord(body) ? body["content"] : undefined;
    const prompt = typeof content === "string" ? content !== "" : Array.isArray(content) && content.length > 0 && !content.some((block) => isRecord(block) && block["type"] === "tool_result");
    if (prompt) owners.push(message["uuid"]);
  }
  return owners;
};

/**
 * A message that names no owner where the SDK says one may be missing: a
 * result that failed to deliver or came back zeroed, or the synthetic
 * assistant message a delivery failure writes (the signed-out answer).
 */
const deliveryFailure = (message: unknown): boolean => {
  if (!isRecord(message) || message["parent_tool_use_id"] != null) return false;
  if (message["type"] === "result") return true;
  if (message["type"] !== "assistant") return false;
  const body = message["message"];
  return message["is_api_error_message"] === true || (isRecord(body) && body["model"] === "<synthetic>");
};

/** A message that says the turn has begun without naming its owner: the model speaking on the main thread, or the turn's result. */
const speaksWithoutOwner = (message: unknown): boolean => {
  if (!isRecord(message) || message["parent_tool_use_id"] != null) return false;
  if (message["type"] === "result" || message["type"] === "assistant") return true;
  return message["type"] === "stream_event" && isRecord(message["event"]) && message["event"]["type"] !== "ping";
};

const isInit = (message: unknown): boolean => isRecord(message) && message["type"] === "system" && message["subtype"] === "init";

/** A user message as the streaming input takes it, stamped with the harness's message id. */
/** The image media types the SDK's image block takes (`Base64ImageSource`). */
export const CLAUDE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

/** An image's media type as the SDK takes it; another is refused rather than sent under a label that is not its own. */
const claudeImageType = (mediaType: string): ClaudeImageType => {
  if ((CLAUDE_IMAGE_TYPES as readonly string[]).includes(mediaType)) return mediaType as ClaudeImageType;
  throw new Error(`Claude does not take ${mediaType} images; it takes ${CLAUDE_IMAGE_TYPES.join(", ")}.`);
};

/** Throws unless every image the messages carry is one Claude takes. */
export const checkImages = (messages: readonly PromptMessage[]): void => {
  for (const message of messages) for (const attachment of message.attachments) if (attachment.kind === "image") claudeImageType(attachment.mediaType);
};

const userMessage = (message: PromptMessage): SDKUserMessage => {
  const images = message.attachments.filter((attachment) => attachment.kind === "image");
  const content: SDKUserMessage["message"]["content"] =
    images.length === 0
      ? message.text
      : [
          // Images before the text: a question placed after its image is answered better.
          ...images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: claudeImageType(image.mediaType), data: Buffer.from(image.data).toString("base64") },
          })),
          ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
        ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: message.messageId as NonNullable<SDKUserMessage["uuid"]> };
};

/** What a spawn fixed, which a later run must share to attach. */
interface SpawnKey {
  readonly directory: string;
  readonly trusted: boolean;
  readonly toolServers: string;
  readonly bypassAllowed: boolean;
  /** The instruction text the spawn appended to the preset: a run with other text (a completions request's own, #138) needs a spawn of its own. */
  readonly instructions: string;
  /**
   * What the spawn's sandbox and deny rules were made from (#140): the run's
   * containment (level, mechanism, network, writable set and what it closes
   * inside it, #791) and the denylist it
   * projects, both fixed when the CLI starts. A run with another needs a
   * spawn of its own.
   */
  readonly confinement: string;
  /** The key of the process environment the spawn was supplied from (#307): a run with another key needs a spawn of its own. */
  readonly environment: string;
  /** The fingerprint of the skill set the spawn loaded (#495): its generation and hidden names are fixed when the CLI starts. */
  readonly skills: string | null;
}

/** A run's containment and projected denylist as one comparable value: the parts the options read, in a fixed order. */
const confinementOf = (input: RunInput): string => {
  const { containment, denylist } = input;
  return JSON.stringify([
    containment.level,
    containment.mechanism,
    containment.network,
    containment.writable,
    containment.readOnly,
    input.additionalDirectories ?? [],
    denylist === null ? null : [denylist.paths, denylist.exempt, denylist.commandPatterns],
  ]);
};

/** What the process last applied, so an attached run sends only what differs. */
interface Applied {
  model: string;
  mode: ClaudeMode;
  effort: string | null;
}

/** The control requests the pinned SDK has at run time without declaring them, detected once per process. */
interface Features {
  /** `interrupt({cancelQueued: true})`: the interrupt withdraws what the CLI still holds and names it under `cancelled`. */
  readonly cancelQueued: boolean;
  /** `cancelAsyncMessage(uuid)`: withdraws one queued message. */
  readonly cancelById: boolean;
}

type InterruptReceipt = { readonly still_queued?: readonly string[]; readonly cancelled?: readonly string[] } | undefined;

/** The undeclared surface of the pinned SDK's `Query`, as the adapter reaches it. */
interface QueryControls {
  interrupt(options?: { cancelQueued?: boolean }): Promise<InterruptReceipt>;
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
}

/** Whether a query has the undeclared controls, and whether the CLI advertised the cancel on its `init`. */
export const detectFeatures = (query: unknown, capabilities: readonly string[] | null): Features => {
  const bag = (query ?? {}) as Record<string, unknown>;
  const interrupt = bag["interrupt"];
  const takesOptions = typeof interrupt === "function" && interrupt.length >= 1;
  return {
    cancelQueued: takesOptions && (capabilities === null || capabilities.includes("interrupt_cancel_queued_v1")),
    cancelById: typeof bag["cancelAsyncMessage"] === "function",
  };
};

export class ClaudeProcess implements TurnControl {
  readonly sessionId: string;
  readonly #deps: ProcessDeps;
  readonly #prompts = new AsyncQueue<SDKUserMessage>("prompt pump");
  readonly #abort = new AbortController();
  readonly #ledger: TaskLedger;
  /** What the process has spent so far, by its results: each turn reports its share (#1949). */
  readonly #spend = new SpendMeter();
  readonly #spawn: SpawnKey;
  /**
   * The tool servers the process was started with, whose in-process tools
   * serve every run it serves (a later run attaches only when its tools
   * have the same key): the gate reads a call to one as its tool declares.
   */
  readonly #toolServers: readonly ToolServer[];
  #applied: Applied;
  /** Settles once every settings call begun so far has; never rejects (`#serially`). */
  #settingsCalls: Promise<void> = Promise.resolve();
  #context: RunContext;
  #query: Query | undefined;
  #features: Features | undefined;
  #capabilities: readonly string[] | null = null;
  #providerSessionId: string | null = null;
  /** Whether the host has been told who this process's CLI is signed in as (`accountInfo`, asked once per process). */
  #identityAsked = false;

  /** The turn the CLI is serving now. */
  #current: ClaudeTurn | undefined;
  /** The completed turn whose result the next prompt_suggestion follows. Cleared by the next init. */
  #suggestionTurn: ClaudeTurn | undefined;
  /** Runs whose prompt is queued at the CLI, not yet opened, in order. */
  readonly #waiting: ClaudeTurn[] = [];
  /** Waiting runs a watchdog gave up on, whose prompts are being withdrawn before they end (`#endUnopened`). */
  readonly #endingUnopened = new Set<ClaudeTurn>();
  /** The messages of a turn whose owner is not known yet, from its `init`. */
  #undecided: unknown[] | undefined;
  readonly #decisionWaiters: (() => void)[] = [];
  /** Whether this CLI narrates its commands and stamps replies with their owners. */
  #narrates = false;
  /** Whether the CLI has opened any turn on this process yet. */
  #anyOpened = false;
  /** Whether the spawn started a conversation, so its first turn can only be its own run's. */
  readonly #spawnedFresh: boolean;
  /**
   * A turn opened for a subagent's prompt between the CLI's turns: no turn
   * of the CLI's is behind it, so it is not the current one, and it ends
   * once the prompts it carries are answered.
   */
  #promptTurn: ClaudeTurn | undefined;
  readonly #forPrompt = new WeakSet<ClaudeTurn>();

  /** Queued messages: sent during a turn, by id, and not yet seen read by any turn. */
  readonly #queuedSends = new Map<string, PromptMessage>();
  /** Queued messages this process cancelled by id, or sent a cancel for without hearing back (#228). */
  readonly #cancelled = new Set<string>();
  /** Queued messages a turn has been seen reading. */
  readonly #seenRead = new Set<string>();
  /**
   * The tool calls the hook let through, by tool use id, with the input it
   * ruled on: the provider's prompt about one is not put to the gate again,
   * unless its input changed since (another hook rewrote it). Oldest first,
   * at most `HOOK_GATED_KEPT`: a prompt follows its hook at once.
   */
  readonly #hookGated = new Map<string, string>();
  /** The recognised file tools' calls the gate let through, told to the observer of the run live then (#1182). */
  readonly #fileTools = new FileToolObservation(
    () => this.#context.fileChanges,
    (message) => this.#deps.diagnostic(`Claude (session ${this.sessionId}): ${message}`),
  );
  /** The permission table: prompts parked on the broker, by prompt id, answerable here too, with the turn that asked. */
  readonly #permissions = new Map<string, { readonly answer: (decision: PromptDecision) => void; readonly turn: ClaudeTurn }>();

  /** Live background tasks by id, from the level alone (retention reads the level, never the ledger), each held on the port. */
  readonly #liveTasks = new Set<string>();
  #crons = 0;
  #wakeups = 0;
  /** Schedule tool calls started and not ended yet, by call id: counted once they end `ok`. */
  readonly #scheduling = new Map<string, string>();
  #settling = false;
  #settleOwed = false;
  #settleTimer: Timer | undefined;
  /** Whether the port holds the schedule hold. */
  #scheduleHeld = false;
  /** The child the SDK spawned through this process's spawner, so a kill reaches it. */
  #child: ChildProcess | undefined;
  /** Resolves once the pump has ended (and the child, when there is one, has exited). */
  #stopped: Promise<void> = Promise.resolve();
  #openTimer: Timer | undefined;

  #closed = false;
  #disposing: Promise<void> | undefined;

  constructor(first: RunInput, context: RunContext, deps: ProcessDeps) {
    const mode = claudeMode(first.mode);
    this.sessionId = first.sessionId;
    this.#deps = deps;
    this.#context = context;
    this.#ledger = new TaskLedger(deps.clock);
    this.#spawn = this.#spawnKeyOf(first);
    this.#toolServers = first.toolServers;
    this.#spawnedFresh = first.target.kind === "fresh";
    this.#applied = { model: first.model, mode, effort: first.effort };
  }

  #spawnKeyOf(input: RunInput): SpawnKey {
    return {
      directory: this.#deps.configDirectory(input.account),
      trusted: input.trusted,
      // An in-process server by what it shows the model: a run whose tools differ needs a process started with them.
      toolServers: toolServersKey(input.toolServers),
      // The SDK's opt-in follows the run's ceiling, so a run under a bypass ceiling may later be changed to bypass.
      bypassAllowed: input.ceiling === "bypassPermissions",
      instructions: input.instructions,
      confinement: confinementOf(input),
      environment: input.processEnvironment.key,
      skills: input.skillSet.fingerprint,
    };
  }

  get closed(): boolean {
    return this.#closed || this.#disposing !== undefined;
  }

  /**
   * Whether the process has work a fresh process would destroy: a turn open,
   * waiting or undecided, a prompt parked, a live background task. A
   * schedule or a grace alone is not: a run it cannot serve lets it go.
   */
  get busy(): boolean {
    return this.#current !== undefined || this.#waiting.length > 0 || this.#undecided !== undefined || this.#liveTasks.size > 0 || this.#permissions.size > 0;
  }

  /** Whether a run can be served on this process rather than a fresh one. */
  canServe(input: RunInput): boolean {
    if (this.closed || this.#current !== undefined || this.#waiting.length > 0 || this.#undecided !== undefined) return false;
    if (input.target.kind !== "resume" || input.target.providerSessionId !== this.#providerSessionId) return false;
    const key = this.#spawnKeyOf(input);
    if (key.directory !== this.#spawn.directory || key.trusted !== this.#spawn.trusted || key.toolServers !== this.#spawn.toolServers) return false;
    // The instructions are fixed at spawn (the preset's append): other text is a fresh process's.
    if (key.instructions !== this.#spawn.instructions) return false;
    // So are the sandbox and the deny rules: another level, mechanism or projected denylist is a fresh process's (#140).
    if (key.confinement !== this.#spawn.confinement) return false;
    // And the variables the harness's services put into it (#307): another key is a fresh process's.
    if (key.environment !== this.#spawn.environment) return false;
    // And its skills (#495): another fingerprint is a fresh process's, resuming from the store as changed instructions do.
    if (key.skills !== this.#spawn.skills) return false;
    // A bypass ceiling needs the SDK's opt-in at spawn; a process started without it cannot enter bypass.
    return !key.bypassAllowed || this.#spawn.bypassAllowed;
  }

  /**
   * The queued messages the CLI has not opened a turn with, taken back: a
   * process let go for a run it cannot serve hands them to the fresh one
   * rather than dropping them.
   */
  takeQueuedSends(): PromptMessage[] {
    const taken = [...this.#queuedSends.values()];
    this.#queuedSends.clear();
    return taken;
  }

  /** The first run: spawns the CLI behind the turn's stream, and answers the turn at once. `carried` are a let-go process's queued messages. */
  open(input: RunInput, carried: readonly PromptMessage[] = []): ClaudeTurn {
    const turn = this.#runTurn(input);
    void this.#start(input, turn, carried);
    return turn;
  }

  /** A later run on the live process: moves it onto the run's model, mode and effort, then queues the prompt. */
  attach(input: RunInput, context: RunContext): ClaudeTurn {
    this.#context = context;
    const turn = this.#runTurn(input);
    void (async () => {
      try {
        await this.#apply(input);
      } catch (error) {
        this.#waitingEnds(turn, { reason: "error", error: { message: `Moving the Claude process onto this run failed: ${describe(error)}`, code: "settings" } });
        return;
      }
      if (this.closed) {
        this.#waitingEnds(turn, { reason: "error", error: { message: "The Claude process closed before this run could start; send again.", code: "transport" } });
        return;
      }
      if (turn.ended) return;
      // Built whole before any is pushed, and a message that cannot be built ends the run rather than rejecting unheard
      // (the adapter checks the images before it attaches a run, so this is the process's own guard).
      let prompts: SDKUserMessage[];
      try {
        prompts = input.prompt.map(userMessage);
      } catch (error) {
        this.#waitingEnds(turn, { reason: "error", error: { message: describe(error), code: "launch" } });
        return;
      }
      for (const prompt of prompts) this.#prompts.push(prompt);
      this.#armOpenWatch();
    })();
    return turn;
  }

  #runTurn(input: RunInput): ClaudeTurn {
    const turn = new ClaudeTurn({
      origin: "run",
      runId: input.runId,
      promptIds: input.prompt.map((message) => message.messageId),
      messageIds: [],
      control: this,
      clock: this.#deps.clock,
      ledger: this.#ledger,
      spend: this.#spend,
    });
    this.#waiting.push(turn);
    return turn;
  }

  /** Ends a run that never opened. */
  #waitingEnds(turn: ClaudeTurn, end: Omit<RunEnd, "type">): void {
    const at = this.#waiting.indexOf(turn);
    if (at !== -1) this.#waiting.splice(at, 1);
    turn.end(end);
    this.#armOpenWatch();
  }

  #apply(input: RunInput): Promise<void> {
    return this.#serially(async () => {
      const query = this.#query;
      if (query === undefined) return;
      const mode = claudeMode(input.mode);
      const effort = claudeEffort(input.effort);
      const limit = this.#deps.timings.controlTimeoutMs;
      // Each setting is recorded as it lands, so a call that fails part way leaves the record true to the CLI.
      if (input.model !== this.#applied.model) {
        await this.#within(query.setModel(input.model), limit);
        this.#applied = { ...this.#applied, model: input.model };
      }
      if (mode !== this.#applied.mode) {
        await this.#within(query.setPermissionMode(mode), limit);
        this.#applied = { ...this.#applied, mode };
      }
      if (input.effort !== this.#applied.effort) {
        await this.#within(query.applyFlagSettings({ effortLevel: effort }), limit);
        this.#applied = { ...this.#applied, effort: input.effort };
      }
    });
  }

  /**
   * Runs the calls that move the CLI's settings (a run's move onto the
   * process, a live mode change) one at a time, in order, so each reads what
   * the one before it left in `#applied` rather than a record an unfinished
   * call is about to overwrite.
   */
  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#settingsCalls.then(work, work);
    this.#settingsCalls = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Where a fork from a message or a rewind re-enters the stored chain; null for any other run. */
  async #resumePoint(input: RunInput): Promise<ResumePoint | null> {
    const target = input.target;
    const anchor = target.kind === "rewind" ? target.toMessageId : target.kind === "fork" ? target.atMessageId : null;
    if (anchor === null || target.kind === "fresh" || target.kind === "resume") return null;
    const stored = await readStoredSession({
      queue: this.#deps.queue,
      harnessSessionId: input.sessionId,
      directory: this.#deps.configDirectory(input.account),
      providerSessionId: target.providerSessionId,
      sessionStore: this.#deps.sessionStore,
      getSessionMessages: sdkGetSessionMessages,
    });
    const point = target.kind === "rewind" ? resolveRewindPoint(stored, anchor) : resolveForkPoint(stored, anchor);
    if (point !== null) return point;
    // Off the latest chain but stored: a run after a rewind branched past it and did not complete, so the chain goes on as it stands.
    const store = this.#deps.sessionStore;
    const offChain = !stored.some((entry) => entry.uuid === anchor) && store !== null && (await storedHolds(store, input.sessionId, target.providerSessionId, anchor));
    if (offChain) return { passed: true };
    throw new Error(`The message ${anchor} is not in the stored conversation, or nothing comes before it; a fork or a rewind from the first message is a new session.`);
  }

  async #start(input: RunInput, turn: ClaudeTurn, carried: readonly PromptMessage[]): Promise<void> {
    let options: Options;
    try {
      if (input.target.kind === "resume" && input.target.sourceDirectory !== undefined && this.#deps.sessionStore === null) throw new Error("This imported Session is read-only: secondary continuation requires the harness store.");
      // A cold run that continues a provider session through the store runs the CLI in the SDK's temporary copy of the
      // account's directory, whose credentials have no refresh token: the login is refreshed in the account's own first.
      if (this.#deps.sessionStore !== null && input.target.kind !== "fresh") await this.#deps.freshLogin(input.account);
      // A resume of a provider session the store holds nothing of (an imported session's first run, #579): the store takes it from
      // the account's directory first, so the run resumes from the store as later runs do and the directory is only read.
      if (this.#deps.sessionStore !== null && input.target.kind === "resume") {
        await seedStoreFromDirectory({
          queue: this.#deps.queue,
          directory: input.target.sourceDirectory ?? this.#deps.configDirectory(input.account),
          required: input.target.sourceDirectory !== undefined,
          harnessSessionId: input.sessionId,
          providerSessionId: input.target.providerSessionId,
          store: this.#deps.sessionStore,
          importSessionToStore: (sessionId, store) => sdkImportSessionToStore(sessionId, store),
        });

      }
      // The CLI restores its saved cost ledger on cold continuation, even when the new turn is stopped before sampling.
      // Seed this process's meter with the same baseline, so its first result cannot charge earlier runs again (#1949).
      if (this.#deps.sessionStore !== null && input.target.kind !== "fresh") {
        const providerSessionId = input.target.providerSessionId;
        const entries = await this.#deps.sessionStore.load({ projectKey: input.sessionId, sessionId: input.target.providerSessionId });
        const saved = entries?.findLast((entry) => entry.type === "cost-state" && entry["sessionId"] === providerSessionId);
        if (saved !== undefined) this.#spend.restore(saved["modelUsage"]);
      }
      const resumePoint = await this.#resumePoint(input);
      // Asked once for this spawn (#307), and not for one that will not happen; the pool releases it as it lets the process go.
      const supplied = this.closed || turn.ended ? null : await input.processEnvironment.supply();
      options = buildRunOptions({
        // In the mode it has now, read after the wait: a change made while it was being prepared applies to the spawn.
        run: { ...input, mode: this.#applied.mode },
        hostEnv: this.#deps.hostEnv,
        supplied: supplied?.variables ?? {},
        suppliedWritable: supplied?.writable ?? [],
        configDirectory: this.#deps.configDirectory(input.account),
        executablePath: this.#deps.executablePath(),
        autoMemoryDirectory: this.#deps.autoMemoryDirectory(input),
        checkoutRoot: worktreeCheckout(input.workspace.path),
        sessionStore: this.#deps.sessionStore,
        resumePoint,
        canUseTool: this.#canUseTool,
        preToolUse: this.#preToolUse,
        fileTools: this.#fileTools.hooks,
        onStop: this.#onStop,
        spawnProcess: this.#spawnProcess,
        abortController: this.#abort,
        stderr: (data) => this.#deps.diagnostic(`Claude (session ${this.sessionId}): ${data.trimEnd()}`),
      });
      if (this.closed) throw new Error("The run was let go before its process started.");
      if (turn.ended) {
        // Interrupted while the process was being prepared: nothing is spawned for it.
        this.#neverRan();
        return;
      }
      for (const message of input.prompt) this.#prompts.push(userMessage(message));
      for (const message of carried) {
        this.#queuedSends.set(message.messageId, message);
        turn.queued.add(message.messageId);
        this.#prompts.push(userMessage(message));
      }
      this.#query = sdkQuery({ prompt: this.#prompts, options });
    } catch (error) {
      const lapsed = error instanceof LoginLapsed;
      this.#waitingEnds(turn, { reason: "error", error: { message: describe(error), code: lapsed ? LOGIN_EXPIRED_CODE : "launch" } });
      this.#neverRan();
      // Nothing started signed out: the store reads the account again, and finds it expired while its login cannot be refreshed.
      if (lapsed) this.#context.recheckAccount();
      return;
    }
    this.#armOpenWatch();
    this.#stopped = this.#pump(this.#query);
  }

  /**
   * No process ever ran (the launch failed, or its run ended before anything
   * spawned): it is let go, and the pool, which counts it from the run's
   * begin, records it stopped on its own, unless the pool is stopping it.
   */
  #neverRan(): void {
    this.#close();
    if (this.#disposing === undefined) this.#context.process.exited();
  }

  async #pump(query: Query): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of query) {
        this.#observe(message);
        this.#route(message);
      }
    } catch (error) {
      failure = describe(error);
    } finally {
      this.#closed = true;
      const end: Omit<RunEnd, "type"> = {
        reason: "error",
        error: { message: failure ?? "The Claude process ended before the turn did.", code: "transport" },
      };
      // Whatever was waiting for a decision is the first waiting run's, if there is one: nothing else will run here.
      if (this.#undecided !== undefined) {
        if (this.#waiting.length > 0) this.#decide("first-waiting");
        else this.#undecided = undefined;
      }
      this.#current?.end(end);
      this.#current = undefined;
      for (const waiting of this.#waiting.splice(0)) {
        waiting.end({ reason: "error", error: { message: "The Claude process closed before this run could start; send again.", code: "transport" } });
      }
      this.#settleWaiters();
      this.#denyAll(DISPOSED_DENY_MESSAGE);
      this.#fileTools.abandon();
      // A subagent's prompt turn ends as its siblings do: its prompts were just denied because the process died, not answered.
      if (this.#promptTurn !== undefined) this.#endPromptTurn(this.#promptTurn, end);
      const onItsOwn = this.#disposing === undefined;
      this.#close();
      // Died on its own (a transport failure, the CLI quitting): the pool records it stopped and the next run starts cold.
      if (onItsOwn) {
        this.#unholdAll();
        this.#context.process.exited();
      }
      const child = this.#child;
      // `exit`, or `close` for a child that failed to spawn: Node reports that as `error` then `close`, with no `exit`.
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.once("close", () => resolve());
        });
      }
    }
  }

  /**
   * The SDK's spawn, made here (`spawnClaudeCodeProcess`), so the process
   * holds its child: `stopProcess` with `kill` sends it SIGKILL at once
   * rather than waiting out the SDK's graceful close. Stdin, stdout and
   * stderr are piped as the SDK's own spawn pipes them; stderr goes to the
   * diagnostic.
   */
  readonly #spawnProcess = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      ...(spawnOptions.cwd !== undefined && { cwd: spawnOptions.cwd }),
      env: spawnOptions.env,
      signal: spawnOptions.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr?.on("data", (chunk: Buffer) => this.#deps.diagnostic(`Claude (session ${this.sessionId}): ${chunk.toString().trimEnd()}`));
    child.on("error", () => undefined);
    this.#child = child;
    return child as unknown as SpawnedProcess;
  };

  /**
   * Stops the process for the pool: the transport closed, the pump's end
   * awaited, so the promise resolves once it has stopped. With `kill`, the
   * child is sent SIGKILL at once and nothing is waited for.
   */
  stop(options: { readonly kill?: boolean } = {}): Promise<void> {
    void this.dispose();
    if (options.kill === true) {
      this.#child?.kill("SIGKILL");
      return Promise.resolve();
    }
    return this.#stopped;
  }

  /** What a message says about the process, before any turn sees it: the live tasks, a settle, a rate-limit verdict. */
  #observe(message: unknown): void {
    const verdict = readRateLimit(message);
    if (verdict !== null) this.#deps.onRateLimit(verdict);
    if (!isRecord(message) || message["type"] !== "system" || message["subtype"] !== "background_tasks_changed" || !Array.isArray(message["tasks"])) return;
    const had = this.#liveTasks.size > 0;
    const now = new Set<string>();
    for (const task of message["tasks"]) {
      const id = isRecord(task) && typeof task["task_id"] === "string" && task["task_id"] !== "" ? task["task_id"] : null;
      if (id !== null) now.add(id);
    }
    // Replace, not merge: the level is the whole live set after the change. Each live task holds the process from the pool's idle stop.
    for (const id of this.#liveTasks) if (!now.has(id)) this.#context.process.unhold("task", id);
    for (const id of now) if (!this.#liveTasks.has(id)) this.#context.process.hold("task", id);
    this.#liveTasks.clear();
    for (const id of now) this.#liveTasks.add(id);
    // The empty set arrives a beat before the provider's turn about the work that finished: a turn opening then is about it.
    if (had && this.#liveTasks.size === 0) this.#awaitSettleTurn();
  }

  #route(message: unknown): void {
    if (isRecord(message) && message["type"] === "prompt_suggestion") {
      const turn = this.#suggestionTurn;
      if (turn !== undefined) {
        for (const event of mapSdkMessage(message, turn.state)) {
          if (event.type !== "run.suggested") continue;
          void turn.adoptedRunId().then((runId) => {
            if (runId !== null) this.#context.reportSuggestion?.({ runId, ...event.payload });
          }).catch((error: unknown) => this.#deps.diagnostic(`Recording a prompt suggestion failed: ${describe(error)}`));
        }
      }
      return;
    }
    if (isInit(message)) this.#suggestionTurn = undefined;
    if (this.#undecided !== undefined) {
      this.#undecided.push(message);
      const owners = ownersOf(message);
      if (owners.length > 0) this.#decide(owners);
      // The first turn of a spawn that started a conversation is its own run's: no earlier work can be answered ahead of it.
      // A result naming nobody before any turn opened is the spawn's run failing to start, whatever it resumed.
      else if (!this.#anyOpened && this.#waiting.length > 0 && (this.#spawnedFresh ? speaksWithoutOwner(message) : isRecord(message) && message["type"] === "result")) {
        this.#decide("first-waiting");
      } else if (deliveryFailure(message) && this.#waiting.length === 1 && this.#nothingElseOwed()) {
        // The SDK omits the owners on a delivery failure or a zeroed result; with one run waiting and nothing else owed, it is that run's.
        this.#decide("first-waiting");
      } else if (speaksWithoutOwner(message)) this.#decide([]);
      return;
    }
    if (this.#current === undefined) {
      if (isInit(message)) {
        this.#reportIdentity();
        this.#undecided = [message];
        this.#armUndecidedWatch();
        const capabilities = isRecord(message) ? message["capabilities"] : undefined;
        if (Array.isArray(capabilities) && this.#capabilities === null) {
          // The first `init` says what this CLI can do; detection runs again once, with it.
          this.#capabilities = capabilities.filter((one): one is string => typeof one === "string");
          this.#narrates = this.#capabilities.includes("msg_lifecycle_v1");
          this.#features = undefined;
        }
        if (!this.#narrates) this.#decide(this.#waiting.length > 0 ? "first-waiting" : []);
        return;
      }
      // Between turns: the ledger still reads what the work that outlived the turn says, and the meter a result's spend.
      this.#ledger.observe(message);
      this.#spend.read(message);
      return;
    }
    this.#serve(this.#current, message);
  }

  /**
   * Tells the host who the CLI says it is signed in as, once the process's
   * first `init` shows it is up: the account store cross-checks it against
   * the identity it holds (#134). Best effort: a CLI that cannot say, or
   * says no email, reports nothing, and a report the host fails to take (the
   * cross-check appends, and may run as the environment closes) is a
   * diagnostic, never an unhandled rejection.
   */
  #reportIdentity(): void {
    const query = this.#query;
    if (this.#identityAsked || query === undefined) return;
    this.#identityAsked = true;
    const context = this.#context;
    query.accountInfo().then(
      (info) => {
        const email = info.email ?? "";
        if (email === "") return;
        const organisation = info.organization ?? "";
        try {
          context.reportIdentity({ provider: CLAUDE_PROVIDER, email, organisation: organisation === "" ? null : organisation });
        } catch (error) {
          this.#deps.diagnostic(`Claude (session ${this.sessionId}): reporting who the CLI is signed in as failed.`, error);
        }
      },
      (error: unknown) => this.#deps.diagnostic(`Claude (session ${this.sessionId}): reading who the CLI is signed in as failed.`, error),
    );
  }

  /** No queued message, settle, live task or scheduled job (whose firing is a turn with no message behind it) that a turn could be about instead of the waiting run. */
  #nothingElseOwed(): boolean {
    return this.#queuedSends.size === 0 && !this.#settling && !this.#settleOwed && this.#liveTasks.size === 0 && this.#crons === 0 && this.#wakeups === 0;
  }

  /** Maps a message onto the open turn, noting a steer it read and a schedule it registered, and closes the turn at its end. */
  #serve(turn: ClaudeTurn, message: unknown): void {
    for (const owner of ownersOf(message)) {
      if (!this.#queuedSends.delete(owner)) continue;
      this.#seenRead.add(owner);
      turn.emit({ type: "message.delivered", payload: { messageId: owner, delivery: "steered" } });
    }
    for (const event of turn.map(message)) {
      if (event.type === "tool.started") {
        if (event.payload.name === CRON_CREATE || event.payload.name === CRON_DELETE || event.payload.name === WAKEUP) this.#scheduling.set(event.payload.toolCallId, event.payload.name);
        continue;
      }
      if (event.type !== "tool.ended") continue;
      const name = this.#scheduling.get(event.payload.toolCallId);
      this.#scheduling.delete(event.payload.toolCallId);
      // A call denied, failed or cancelled registered nothing, and removed nothing.
      if (name === undefined || event.payload.status !== "ok") continue;
      if (name === CRON_CREATE) this.#crons += 1;
      else if (name === CRON_DELETE) this.#crons = Math.max(0, this.#crons - 1);
      else this.#wakeups += 1;
      this.#holdSchedule();
    }
    if (turn.state.providerSessionId !== null) this.#providerSessionId = turn.state.providerSessionId;
    // Work that changed between turns is reported by the next turn to hear anything.
    if (!turn.ended && this.#ledger.dirty) turn.emit({ type: "tasks.changed", payload: { tasks: this.#ledger.snapshot() } });
    if (turn.ended && this.#current === turn) {
      this.#suggestionTurn = turn.state.completed ? turn : undefined;
      this.#current = undefined;
      // A tool call still parked on the ended turn is denied, never allowed later: the adapter denies its run's prompts as
      // the run ends, since the host, which then refuses an answer run_ended, has no run left to ask.
      this.#denyAll(ENDED_DENY_MESSAGE, turn);
      this.#afterTurn();
    }
  }

  /**
   * Opens the turn the held messages belong to: the waiting run whose prompt
   * the owners name (or the first waiting run), else a turn of the
   * provider's own, handed to the adoption hook with the queued messages it
   * opened with. Then the held messages are served. A run the host asked to
   * interrupt before it opened is interrupted now, and not before: the turn
   * the CLI ran ahead of it was not the run's to stop.
   */
  #decide(owners: readonly string[] | "first-waiting"): void {
    const held = this.#undecided ?? [];
    this.#undecided = undefined;
    this.#anyOpened = true;
    this.#openTimer?.cancel();
    const named = owners === "first-waiting" ? [] : owners;
    const at = owners === "first-waiting" ? (this.#waiting.length > 0 ? 0 : -1) : this.#waiting.findIndex((turn) => turn.promptIds.some((id) => named.includes(id)));
    const opened = named.filter((id) => this.#queuedSends.delete(id));
    for (const id of opened) this.#seenRead.add(id);
    if (at !== -1) {
      const turn = this.#waiting.splice(at, 1)[0] as ClaudeTurn;
      this.#current = turn;
      turn.markOpened();
      // Queued messages the CLI folded into this run's opening turn were read by it.
      for (const messageId of opened) turn.emit({ type: "message.delivered", payload: { messageId, delivery: "prompt" } });
    } else {
      // A turn of the provider's own with no message behind it is a wakeup firing, when one is registered.
      if (opened.length === 0 && this.#wakeups > 0) {
        this.#wakeups -= 1;
        this.#holdSchedule();
      }
      this.#current = this.#providerTurn(opened, false);
    }
    this.#settleWaiters();
    for (const message of held) this.#route(message);
  }

  /**
   * A turn the provider opened on its own, adopted by the host as a run of
   * the session: the CLI's own turn (`forPrompt` false, the current one), or
   * one carrying a subagent's prompt between the CLI's turns.
   */
  #providerTurn(messageIds: readonly string[], forPrompt: boolean): ClaudeTurn {
    const turn = new ClaudeTurn({ origin: "provider", runId: "", promptIds: [], messageIds, control: this, clock: this.#deps.clock, ledger: this.#ledger, spend: this.#spend });
    turn.markOpened();
    if (forPrompt) this.#forPrompt.add(turn);
    else {
      // A turn opening ends the settle grace's wait; its end re-arms it while the debt is owed.
      this.#settling = false;
      this.#settleTimer?.cancel();
    }
    this.#deps.diagnostic(
      `Claude (session ${this.sessionId}): the provider opened a turn of its own${forPrompt ? " for a subagent's prompt" : ""}${messageIds.length > 0 ? ` with ${messageIds.length} queued message(s)` : ""}.`,
    );
    this.#context.adopt(turn);
    return turn;
  }

  /**
   * A turn ended, at a result or not: the settle debt re-arms its grace, so
   * it clears however the turn ended, and the watchdog watches any run still
   * waiting. The ids of queued messages are kept, so a turn opening later
   * still reports reading them.
   */
  #afterTurn(): void {
    if (this.#settleOwed) this.#awaitSettleTurn();
    this.#armOpenWatch();
  }

  /**
   * An init nobody is named in yet waits for what follows it to say whose
   * turn it is (a narrating CLI). One that says nothing more within the open
   * timeout is a CLI gone quiet: the init is dropped, so it holds nothing
   * busy, and the runs waiting on it end `error` as unopened runs do.
   */
  #armUndecidedWatch(): void {
    this.#openTimer?.cancel();
    this.#openTimer = this.#deps.clock.setTimeout(() => {
      if (this.#current !== undefined || this.#undecided === undefined) return;
      this.#undecided = undefined;
      this.#settleWaiters();
      this.#endUnopened(`The Claude process began a turn and said nothing more within ${this.#deps.timings.openTimeoutMs} ms`);
    }, this.#deps.timings.openTimeoutMs);
  }

  /**
   * The watchdog for a run whose prompt the CLI never opens: while runs wait
   * and the CLI serves no turn, the open timeout runs; when it passes, every
   * waiting run ends error, so none pins the process for ever. While an init
   * is undecided its own bound (`#armUndecidedWatch`) holds the slot and is
   * left running: a run ending meanwhile does not restart or cancel it.
   */
  #armOpenWatch(): void {
    if (this.#undecided !== undefined) return;
    this.#openTimer?.cancel();
    if (this.closed || this.#waiting.length === 0 || this.#current !== undefined) return;
    this.#openTimer = this.#deps.clock.setTimeout(() => {
      if (this.#current !== undefined || this.#undecided !== undefined) return;
      this.#endUnopened(`The Claude process did not open this run's turn within ${this.#deps.timings.openTimeoutMs} ms`);
    }, this.#deps.timings.openTimeoutMs);
  }

  /**
   * Ends every waiting run a watchdog gave up on, `error` (code
   * `not_opened`), once its prompt and what was queued with it are withdrawn
   * from the CLI's queue, as an interrupt withdraws an unopened run's: a CLI
   * that opens late (a slow cold start) would otherwise run them as a turn of
   * its own after the person sent them again. The runs wait meanwhile, so one
   * the CLI opens in between is its turn and goes on. One whose prompt the
   * CLI does not give back (no cancel-by-id control, a cancel unanswered, a
   * prompt it read) ends saying the CLI may still run it, not "send again".
   */
  #endUnopened(why: string): void {
    for (const turn of this.#waiting) {
      if (this.#endingUnopened.has(turn)) continue;
      this.#endingUnopened.add(turn);
      void (async () => {
        const withIt = [...turn.queued].filter((id) => this.#queuedSends.has(id));
        const query = this.#query;
        const withdrawn = query === undefined || (this.#featuresOf(query).cancelById && (await this.#withdraw(query, [...turn.promptIds, ...withIt])));
        this.#endingUnopened.delete(turn);
        if (withdrawn) for (const id of withIt) this.#queuedSends.delete(id);
        if (turn.opened || turn.ended) return;
        const message = withdrawn ? `${why}; send again.` : `${why}, and its prompt could not be taken back from the CLI's queue: the CLI may still run it.`;
        this.#waitingEnds(turn, { reason: "error", error: { message, code: "not_opened" } });
      })();
    }
  }

  #awaitSettleTurn(): void {
    this.#settleOwed = true;
    this.#settling = true;
    this.#settleTimer?.cancel();
    if (this.#current !== undefined) return;
    this.#settleTimer = this.#deps.clock.setTimeout(() => {
      this.#settling = false;
      this.#settleOwed = false;
    }, this.#deps.timings.settleGraceMs);
  }

  /** Holds the process for a registered schedule while one is (a cron job or a wakeup), under one synthetic id. */
  #holdSchedule(): void {
    const registered = this.#crons > 0 || this.#wakeups > 0;
    if (registered === this.#scheduleHeld) return;
    this.#scheduleHeld = registered;
    if (registered) this.#context.process.hold("schedule", SCHEDULE_HOLD_ID);
    else this.#context.process.unhold("schedule", SCHEDULE_HOLD_ID);
  }

  /**
   * The CLI's own list of the session's scheduled jobs, as each turn stops
   * (the Stop hook's `session_crons`): the counts follow it, so a one-shot
   * job that fired or expired, which no tool call removes, lets the hold go.
   */
  readonly #onStop: HookCallback = async (input) => {
    const crons = (input as { readonly session_crons?: unknown }).session_crons;
    if (input.hook_event_name === "Stop" && Array.isArray(crons) && !this.closed) {
      const recurring = crons.filter((cron) => isRecord(cron) && cron["recurring"] === true).length;
      this.#crons = recurring;
      this.#wakeups = crons.length - recurring;
      this.#holdSchedule();
    }
    return {};
  };

  /**
   * The tool gate's hook (#140; permissions spec, "Provider deny rules where
   * they must apply"): the SDK's in-process `PreToolUse` callback, which the
   * CLI runs before its own evaluation of every tool call, in every mode,
   * bypass included, a subagent's calls and a call between the CLI's turns
   * too. A denial is the hook's `deny`, with the gate's message for the
   * model. An allow says nothing, so the call goes on to the mode, the rules
   * and the provider's own prompt: the hook never allows on their behalf.
   * A denylist match is put to the person inside the gate and waited on
   * here (the verify-first fallback #132 chose, which holds in bypass): the
   * CLI waits for as long as `GATE_HOOK_TIMEOUT_SECONDS` allows, and when it
   * gives up it cancels the hook's request, which aborts `signal`, and the
   * gate closes the prompt and denies. A call let through is remembered, so
   * the provider's prompt about it is not gated again (`#canUseTool`). The
   * hook never throws: the CLI reads a hook that failed as one with no
   * opinion and runs the call, so a gate that could not rule denies.
   */
  readonly #preToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    try {
      if (this.closed) return gateDenial(DISPOSED_DENY_MESSAGE);
      await this.#decided();
      if (this.closed) return gateDenial(DISPOSED_DENY_MESSAGE);
      const callId = input.tool_use_id === "" ? randomUUID() : input.tool_use_id;
      const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
      const ruling = await this.#context.gate.check(claudeGatedCall(input.tool_name, toolInput, callId, { servers: this.#toolServers }), signal);
      if (ruling.decision === "deny") return gateDenial(ruling.message);
      this.#hookGated.set(callId, JSON.stringify(toolInput));
      for (const oldest of this.#hookGated.keys()) {
        if (this.#hookGated.size <= HOOK_GATED_KEPT) break;
        this.#hookGated.delete(oldest);
      }
      return {};
    } catch (error) {
      return gateDenial(gateFailed(error));
    }
  };

  /** Whether the hook let this call through as it is now, so the gate need not be asked again; forgets it either way. */
  #gatedByHook(toolUseID: string, input: Record<string, unknown>): boolean {
    const ruledOn = this.#hookGated.get(toolUseID);
    this.#hookGated.delete(toolUseID);
    return ruledOn !== undefined && ruledOn === JSON.stringify(input);
  }

  /**
   * The sandbox's ask for a host (`SandboxNetworkAccess`, #140): at
   * `workspace` the network is open, but the pinned sandbox cannot say "any
   * domain", so it asks the host about each new host a command reaches. No
   * hook sees it and it is no tool call: the gate rules on the host as a
   * fetch (containment's no-network level and the denylist's hosts), and
   * its ruling is the answer. A host the denylist matches is put to the
   * person as a `denylist` prompt of the session's live run, as any match
   * is (the host's broker parks that run itself, so no turn is opened here);
   * any other is allowed at once, with no permission prompt. The CLI
   * remembers an allowed host for the session.
   */
  async #networkAsk(input: Record<string, unknown>, toolUseID: string, signal: AbortSignal): Promise<PermissionResult> {
    try {
      const ruling = await this.#context.gate.check(claudeGatedCall(SANDBOX_NETWORK_TOOL, input, toolUseID === "" ? randomUUID() : toolUseID), signal);
      return ruling.decision === "deny" ? { behavior: "deny", message: ruling.message, toolUseID } : { behavior: "allow", updatedInput: input, toolUseID };
    } catch (error) {
      return { behavior: "deny", message: gateFailed(error), toolUseID };
    }
  }

  /** Lets go of every hold this process took: it is being replaced or stopped. */
  #unholdAll(): void {
    for (const id of this.#liveTasks) this.#context.process.unhold("task", id);
    this.#liveTasks.clear();
    this.#crons = 0;
    this.#wakeups = 0;
    this.#scheduling.clear();
    this.#holdSchedule();
  }

  /** Takes the transport down; the pump's own ending does the rest. */
  #close(): void {
    if (!this.#closed) this.#deps.diagnostic(`Claude (session ${this.sessionId}): letting the process go.`);
    this.#closed = true;
    this.#settleTimer?.cancel();
    this.#openTimer?.cancel();
    this.#prompts.close();
    try {
      this.#query?.close();
    } catch {
      // Already gone.
    }
    this.#deps.onClosed(this);
  }

  #settleWaiters(): void {
    for (const wake of this.#decisionWaiters.splice(0)) wake();
  }

  /** Gives the pump a moment to read whose turn the CLI opened; at once when nothing is undecided. */
  #decided(): Promise<void> {
    if (this.#undecided === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: Timer | undefined = undefined;
      const done = (): void => {
        timer?.cancel();
        resolve();
      };
      timer = this.#deps.clock.setTimeout(done, this.#deps.timings.decisionSettleMs);
      this.#decisionWaiters.push(done);
    });
  }

  /**
   * `canUseTool`, on the broker seam: every request is first put to the
   * tool gate (`RunContext.gate`, #133), whose containment denial is final
   * and asks nobody, then handed to the host's broker (#130: recorded as
   * `prompt.opened`, the run parked) and parked in the
   * permission table until the broker or `answerPrompt` settles it, or the
   * provider aborts it. A request arriving with no turn open is a
   * subagent's, parked long after its own turn ended: a turn of the
   * provider's own carries it, and the broker is asked once the host has
   * adopted that turn and named its run. The gate has ruled on a tool call
   * already in the `PreToolUse` hook (#140), which runs first, so it is
   * asked here only about a call the hook did not let through as it is now
   * (one another hook rewrote, or one no hook saw). The sandbox's ask for a
   * host is no tool call: it is answered from the gate alone
   * (`#networkAsk`).
   */
  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    const toolUseID = options.toolUseID;
    if (this.closed) return { behavior: "deny", message: DISPOSED_DENY_MESSAGE, toolUseID };
    await this.#decided();
    // Let go while it waited: a stop settles the waiters, and no turn may open on a process the adapter has forgotten.
    if (this.closed) return { behavior: "deny", message: DISPOSED_DENY_MESSAGE, toolUseID };
    // Withdrawn before it was taken (while a decision settled, say): an aborted signal fires no more, so nobody is asked.
    if (options.signal.aborted) return { behavior: "deny", message: ABORTED_DENY_MESSAGE, toolUseID };
    if (toolName === SANDBOX_NETWORK_TOOL) return this.#networkAsk(input, toolUseID, options.signal);
    let turn = this.#current;
    if (turn === undefined) {
      turn = this.#promptTurn !== undefined && !this.#promptTurn.ended ? this.#promptTurn : this.#providerTurn([], true);
      this.#promptTurn = turn;
    }
    const promptId = toolUseID === "" ? randomUUID() : toolUseID;
    let answer!: (decision: PromptDecision) => void;
    const answered = new Promise<PromptDecision>((resolve) => (answer = resolve));
    this.#permissions.set(promptId, { answer, turn });
    const aborted = (): void => answer({ decision: "deny", message: ABORTED_DENY_MESSAGE });
    options.signal.addEventListener("abort", aborted, { once: true });
    try {
      const runId = await Promise.race([turn.adoptedRunId(), answered.then(() => null)]);
      if (runId === null) {
        // Settled before the host named a run for it (aborted, answered, the process let go): the broker is never asked.
        const early = await Promise.race([answered, Promise.resolve<PromptDecision>({ decision: "deny", message: DISPOSED_DENY_MESSAGE })]);
        return this.#result(early, toolName, input, options.suggestions ?? [], toolUseID);
      }
      // The gate before anyone is asked, unless the hook ruled on the call as it is: a containment denial is final, and the
      // model is told why (#133); a denylist match is put to the person first, and only an allowed call comes on to the
      // provider's own prompt (#132). The SDK's signal goes with it: a request the CLI withdraws closes a prompt the gate parked.
      if (!this.#gatedByHook(toolUseID, input)) {
        const ruling = await this.#context.gate.check(claudeGatedCall(toolName, input, promptId, { title: options.title, servers: this.#toolServers }), options.signal);
        if (ruling.decision === "deny") return { behavior: "deny", message: ruling.message, toolUseID };
      }
      const kind = PROMPT_KINDS[toolName] ?? "permission";
      // The CLI's request on the harness's fields: its title is the one-line summary, its reason the provider's.
      const detail: PromptDetail = {
        toolName,
        toolCallId: toolUseID === "" ? null : toolUseID,
        input: toJson(input) as JsonObject,
        summary: options.title ?? options.description ?? null,
        blockedPath: options.blockedPath ?? null,
        reason: options.decisionReason ?? null,
        questions: kind === "question" ? questionsOf(input) : null,
        plan: kind === "plan" ? textOf(input["plan"]) : null,
        suggestions: (options.suggestions ?? []).map((suggestion) => toJson(suggestion) as JsonObject),
        agentId: options.agentID ?? null,
      };
      // The permission table's id is the prompt's: an answer through the host's `deliverAnswer` names the same prompt.
      const asked = this.#context.broker.request({ sessionId: this.sessionId, runId, kind, detail, promptId, signal: options.signal });
      return this.#result(await Promise.race([answered, asked]), toolName, input, options.suggestions ?? [], toolUseID);
    } catch (error) {
      return { behavior: "deny", message: `The request could not be asked: ${describe(error)}`, toolUseID };
    } finally {
      options.signal.removeEventListener("abort", aborted);
      this.#permissions.delete(promptId);
      this.#endPromptTurn(turn);
    }
  };

  #result(decision: PromptDecision, toolName: string, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[], toolUseID: string): PermissionResult {
    if (decision.decision !== "allow") return { behavior: "deny", message: decision.message ?? DEFAULT_DENY_MESSAGE, toolUseID };
    // An approved plan's mode (clamped by the host) is set on the CLI by the result's `setMode`: the record follows it, so a
    // later run's move and a live change read the mode the CLI is in (#140).
    if (decision.mode !== undefined) this.#applied = { ...this.#applied, mode: claudeMode(decision.mode) };
    return allowedResult(toolName, input, decision, suggestions, toolUseID);
  }

  /** A turn carrying only a subagent's prompts ends once none of them is parked: no result of the CLI's will end it. */
  #endPromptTurn(turn: ClaudeTurn, end: Omit<RunEnd, "type"> = { reason: "completed" }): void {
    if (!this.#forPrompt.has(turn) || turn.ended) return;
    if ([...this.#permissions.values()].some((parked) => parked.turn === turn)) return;
    turn.end(end);
    if (this.#promptTurn === turn) this.#promptTurn = undefined;
  }

  #denyAll(message: string, only?: ClaudeTurn): void {
    for (const [promptId, parked] of [...this.#permissions]) {
      if (only !== undefined && parked.turn !== only) continue;
      parked.answer({ decision: "deny", message });
      this.#permissions.delete(promptId);
    }
  }

  /** The undeclared controls this process has, detected once it has a query and re-read after an `init`; a missing one is said once. */
  #featuresOf(query: Query): Features {
    if (this.#features !== undefined) return this.#features;
    const features = detectFeatures(query, this.#capabilities);
    this.#features = features;
    if (!features.cancelQueued) this.#deps.diagnostic(`Claude (session ${this.sessionId}): this SDK or CLI cannot cancel the queue with an interrupt; queued messages are withdrawn one by one, and may run first.`);
    if (!features.cancelById) this.#deps.diagnostic(`Claude (session ${this.sessionId}): this SDK has no cancel-by-id control; a queued message cannot be withdrawn and runs as the provider's next turn.`);
    return features;
  }

  // The turn control: what a turn asks of its process.

  async send(turn: ClaudeTurn, message: PromptMessage): Promise<void> {
    if (this.closed || this.#prompts.closed) throw new Error("The Claude process is closing and takes no more messages.");
    if (turn.ended) throw new Error("The run has ended; its messages go to the next run.");
    // A turn carrying a subagent's prompt has no turn of the CLI's to fold a message into, and its interrupt cannot take
    // one back from the CLI's queue: refused, the environment holds it and its next run reads it (ADR 0022).
    if (this.#forPrompt.has(turn)) throw new Error("This run only carries a subagent's prompt; the message waits for the session's next run.");
    checkImages([message]);
    // Stamped with the harness's id: the CLI names it when a turn reads it, and an interrupt's receipt lists it.
    this.#queuedSends.set(message.messageId, message);
    turn.queued.add(message.messageId);
    this.#prompts.push(userMessage(message));
  }

  async interrupt(turn: ClaudeTurn): Promise<{ readonly stillQueued: readonly string[] }> {
    await this.#decided();
    if (turn.ended) return { stillQueued: [] };
    turn.state.interruptRequested = true;
    // A turn carrying only a subagent's prompts has no turn of the CLI's to interrupt: its prompts are denied and it ends.
    if (this.#forPrompt.has(turn)) {
      this.#denyAll(DISPOSED_DENY_MESSAGE, turn);
      this.#endPromptTurn(turn, { reason: "interrupted", cause: "user" });
      return { stillQueued: [] };
    }
    const query = this.#query;
    if (!turn.opened) {
      // Not spawned yet, or its prompt withdrawn from the CLI's queue together with what was queued with the run (sent
      // onto it, or handed on at its spawn), which the CLI would otherwise run later: the run ends here, those handed back.
      const withIt = [...turn.queued].filter((id) => this.#queuedSends.has(id));
      if (query === undefined || (this.#featuresOf(query).cancelById && (await this.#withdraw(query, [...turn.promptIds, ...withIt])))) {
        for (const id of withIt) this.#queuedSends.delete(id);
        this.#waitingEnds(turn, { reason: "interrupted", cause: "user" });
        return { stillQueued: withIt };
      }
      // The CLI may be running another turn ahead of it, which is not this run's to stop: wait for it to open this one.
      await turn.whenOpened();
      if (turn.ended || this.#current !== turn) return { stillQueued: [] };
    }
    if (query === undefined) return { stillQueued: [] };
    return this.#interruptOpen(query);
  }

  /**
   * Takes back one queued message this process sent (ADR 0022's withdraw,
   * #228). One still in the prompt pump, which the SDK has not read, is
   * taken out of it at once. Otherwise, once whose turn the CLI opened is
   * known: one a turn has been seen reading, or never sent here, is not
   * withdrawn and the CLI is not asked; one this process cancelled before, or
   * whose cancel it sent without hearing back, is withdrawn again without
   * asking (a second `cancelAsyncMessage` would answer false, as for a read
   * one); any other goes to the cancel-by-id control under the control
   * timeout, whose `true` means the CLI dropped it and `false` that a turn
   * read it. A cancel that times out is remembered as sent and throws, so the
   * host's retry asks again and hears it withdrawn. Without the control the
   * message cannot be taken back: `WithdrawUnsupported`.
   */
  async withdraw(messageId: string): Promise<{ readonly withdrawn: boolean }> {
    // Still in the pump, so the SDK has not read it and the CLI cannot have it: taken out here, nobody asked.
    if (this.#queuedSends.has(messageId) && this.#prompts.remove((prompt) => prompt.uuid === messageId)) {
      this.#queuedSends.delete(messageId);
      this.#cancelled.add(messageId);
      return { withdrawn: true };
    }
    await this.#decided();
    if (this.#cancelled.has(messageId)) {
      // Cancelled already, or its cancel sent and never answered: withdrawn, unless a turn has been seen reading it since.
      if (this.#seenRead.has(messageId)) return { withdrawn: false };
      this.#queuedSends.delete(messageId);
      return { withdrawn: true };
    }
    if (!this.#queuedSends.has(messageId)) return { withdrawn: false };
    const query = this.#query;
    const cancel = query === undefined ? undefined : (query as unknown as QueryControls).cancelAsyncMessage;
    if (query === undefined || !this.#featuresOf(query).cancelById || cancel === undefined) {
      throw new WithdrawUnsupported("This Claude SDK has no cancel-by-id control, so a queued message cannot be taken back; it runs as the CLI's next turn.");
    }
    // Remembered before it is sent: an answer that never comes may still be a cancel the CLI made.
    this.#cancelled.add(messageId);
    let withdrawn: boolean;
    try {
      withdrawn = (await this.#within(cancel.call(query, messageId), this.#deps.timings.controlTimeoutMs)) === true;
    } catch (error) {
      throw new Error(`The CLI did not answer the withdraw of message ${messageId}: ${describe(error)}`, { cause: error });
    }
    if (withdrawn) this.#queuedSends.delete(messageId);
    else this.#cancelled.delete(messageId);
    return { withdrawn };
  }

  /**
   * Interrupts the open turn and takes the queue back with it (ADR 0022: an
   * interrupt re-owns the queue and starts nothing). The pinned SDK's
   * `interrupt({cancelQueued: true})`, present at run time though its
   * declarations omit the argument, withdraws in the same request everything
   * the CLI still holds and names it under `cancelled`, so no queued message
   * can run as the next turn in between; the ones this process sent go back
   * to the host. A CLI without it gets the plain interrupt and the
   * one-by-one withdrawal, which can lose that race.
   */
  async #interruptOpen(query: Query): Promise<{ readonly stillQueued: readonly string[] }> {
    const features = this.#featuresOf(query);
    const controls = query as unknown as QueryControls;
    let receipt: InterruptReceipt;
    try {
      receipt = await this.#within(features.cancelQueued ? controls.interrupt({ cancelQueued: true }) : controls.interrupt(), this.#deps.timings.interruptTimeoutMs);
    } catch (error) {
      // The control channel did not answer: the transport comes down and the pump ends the turn interrupted.
      this.#deps.diagnostic(`Claude (session ${this.sessionId}): the interrupt did not complete; forcing the process down.`, describe(error));
      this.#abort.abort();
      this.#close();
      return { stillQueued: [] };
    }
    const reowned: string[] = [];
    if (features.cancelQueued) {
      // Only ids this process sent are handed back; the CLI may list its own (a cron trigger, an auto-resume).
      for (const id of receipt?.cancelled ?? []) if (this.#queuedSends.delete(id)) reowned.push(id);
      return { stillQueued: reowned };
    }
    for (const id of receipt?.still_queued ?? []) {
      if (!this.#queuedSends.has(id)) continue;
      if (features.cancelById && (await this.#withdraw(query, [id]))) {
        this.#queuedSends.delete(id);
        reowned.push(id);
      }
    }
    return { stillQueued: reowned };
  }

  /** Withdraws queued messages by id through the cancel-by-id control (`cancelAsyncMessage`); true only when every one was withdrawn. */
  async #withdraw(query: Query, ids: readonly string[]): Promise<boolean> {
    const cancel = (query as unknown as QueryControls).cancelAsyncMessage;
    if (typeof cancel !== "function" || ids.length === 0) return false;
    let all = true;
    for (const id of ids) {
      try {
        if ((await this.#within(cancel.call(query, id), this.#deps.timings.controlTimeoutMs)) !== true) all = false;
      } catch {
        all = false;
      }
    }
    return all;
  }

  /**
   * A live run's mode change (`modeChange`, `permissions.mode.set`), already
   * clamped by the host to the run's ceiling: the SDK's mode setter on the
   * spawned CLI, under the control timeout, which moves every turn after it;
   * before the spawn, the mode the spawn takes. Bypass needs the SDK's opt-in
   * at spawn, which a process started under a lower ceiling lacks.
   */
  setMode(turn: ClaudeTurn, mode: Mode): Promise<void> {
    // After any move onto a run under way, so it reads the mode that move left.
    return this.#serially(async () => {
      if (this.closed) throw new Error("The Claude process is closing; the run's mode cannot change.");
      if (turn.ended) throw new Error("The run has ended; its session's next run takes the mode.");
      const next = claudeMode(mode);
      if (next === "bypassPermissions" && !this.#spawn.bypassAllowed) {
        throw new Error("This Claude process was started without the bypass opt-in (its run's ceiling was below bypassPermissions), so it cannot change to bypassPermissions.");
      }
      if (next === this.#applied.mode) return;
      const query = this.#query;
      if (query !== undefined) await this.#within(query.setPermissionMode(next), this.#deps.timings.controlTimeoutMs);
      this.#applied = { ...this.#applied, mode: next };
    });
  }

  answerPrompt(promptId: string, decision: PromptDecision): void {
    const parked = this.#permissions.get(promptId);
    if (parked === undefined) throw new PromptClosed(`No prompt ${promptId} is open on this Claude process.`, "not_open");
    if (parked.turn.ended || this.closed) {
      // The run has ended (a transport failure, an end from outside): its tool call must not run, and nothing will ask again.
      parked.answer({ decision: "deny", message: ENDED_DENY_MESSAGE });
      throw new PromptClosed(`The run prompt ${promptId} belongs to has ended; the answer reaches no tool call.`, "run_ended");
    }
    parked.answer(decision);
  }

  /**
   * Stops one piece of delegated work, under the control timeout like every
   * other control call. A stop that does not answer in time is refused to
   * the caller and nothing else: the run and its other work go on, and the
   * task, if it did stop, settles through the ledger as any task does.
   */
  async stopTask(taskId: string): Promise<void> {
    if (this.closed) throw new Error("The Claude process is closing; its tasks stop with it.");
    const query = this.#query;
    if (query === undefined) throw new Error(`The Claude process has not started, so it has no task ${taskId} to stop.`);
    await this.#within(query.stopTask(taskId), this.#deps.timings.controlTimeoutMs);
  }

  /** The host is done with an ended turn: nothing is let go, since the process is kept for the next run until the pool stops it. */
  release(): void {
    // The process's state is its turns' and holds', none of which a release changes.
  }

  /** Stops the process now: the host has let a run go (its session deleted, the environment closing), or a fresh process replaces it. */
  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#denyAll(DISPOSED_DENY_MESSAGE);
      for (const turn of [this.#current, this.#promptTurn, ...this.#waiting]) turn?.close();
      this.#current = undefined;
      this.#promptTurn = undefined;
      this.#waiting.length = 0;
      this.#undecided = undefined;
      this.#unholdAll();
      this.#settleWaiters();
      this.#close();
      this.#abort.abort();
    })();
    return this.#disposing;
  }

  /** The provider's session this process writes to, once its first `init` said. */
  get providerSessionId(): string | null {
    return this.#providerSessionId;
  }

  /** Rejects if `promise` has not settled within `ms` on the environment's clock. */
  #within<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.#deps.clock.setTimeout(() => reject(new Error(`No answer after ${ms} ms.`)), ms);
      promise.then(
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
  }
}
