import { randomUUID } from "node:crypto";
import {
  getSessionMessages as sdkGetSessionMessages,
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { PromptDecision, PromptKind, PromptMessage, RunContext, RunEnd, RunInput } from "../../adapter/contract.js";
import type { Clock, Timer } from "../../serve/clock.js";
import { AsyncQueue } from "./async-queue.js";
import type { ConfigDirQueue } from "./config-dir-queue.js";
import type { HostEnvironment } from "./credentials.js";
import { readStoredSession, resolveForkPoint, resolveRewindPoint } from "./history.js";
import { readRateLimit, toJson } from "./mapper.js";
import { buildRunOptions, claudeEffort, claudeMode, type ClaudeMode, type ResumePoint } from "./options.js";
import type { PlanLimitVerdict } from "./plan-usage.js";
import { TaskLedger } from "./tasks.js";
import { ClaudeTurn, type TurnControl } from "./turn.js";
import { worktreeCheckout } from "./workspace.js";

/**
 * The Claude process (claude-adapter spec, "Environment-owned provider
 * processes" and "The Claude adapter": Artemis's prompt pump, permission
 * table, task ledger and settle grace, moved out of the run into the
 * process). `query()` takes its streaming input once and answers one
 * `Query`, so the input, the transport, the abort controller and the
 * `canUseTool` callback are fixed at spawn and belong to the process; a turn
 * (`turn.ts`) is one run. The process serves turns one at a time, as the CLI
 * does, and outlives them: the next run of the conversation attaches to it
 * when it can (same account, same trust, same tool servers, the provider
 * session the run resumes), and a turn the provider opens on its own, a
 * settled background task answered or a queued message read, is a new turn
 * handed to the host's adoption hook.
 *
 * Whose turn the CLI has opened is read from the stream, not assumed: the
 * pinned CLI narrates (`msg_lifecycle_v1` on `init`) and stamps a turn's
 * first reply with the uuids of the prompts it consumed
 * (`user_message_uuid(s)`), and a prompt is stamped with the harness's
 * message id, so an `init` is held until a message names its owner. A turn
 * naming a waiting run's prompt is that run's; any other is the provider's
 * own, adopted, and the waiting run keeps waiting behind it. A CLI that does
 * not narrate is read as Artemis did before it did: a waiting run's prompt
 * opens the next turn.
 *
 * It is let go when the host has released every turn and nothing holds it
 * (Artemis's retention rule): a live background task, a registered schedule,
 * the settle grace after a task settles, the grace a sent message has to
 * open its queued turn, an unanswered prompt. `idleMs` keeps it that much
 * longer for the next run; the pool (#120) is what will own that clock.
 */

/** What a process needs from its adapter. */
export interface ProcessDeps {
  readonly clock: Clock;
  readonly hostEnv: HostEnvironment;
  readonly executablePath: () => string | null;
  readonly sessionStore: SessionStore | null;
  readonly pluginDirectory: (input: RunInput) => string | null;
  readonly autoMemoryDirectory: (input: RunInput) => string | null;
  readonly queue: ConfigDirQueue;
  readonly timings: ProcessTimings;
  readonly diagnostic: (message: string, detail?: unknown) => void;
  /** A run reported a rate-limit verdict for the account: the plan-usage read folds it in. */
  readonly onRateLimit: (verdict: PlanLimitVerdict) => void;
  /** The transport is gone: the adapter forgets the process. */
  readonly onClosed: (process: ClaudeProcess) => void;
}

export interface ProcessTimings {
  /** How long a settled background task holds the process for the provider's turn about it (Artemis: 2 s). */
  readonly settleGraceMs: number;
  /** How long an ended turn holds the process for the queued turn a sent message becomes (Artemis: 5 s). */
  readonly queuedTurnGraceMs: number;
  /** How long an interrupt waits for the control channel before the transport is forced down (Artemis: 8 s). */
  readonly interruptTimeoutMs: number;
  /** How long a prompt waits for the pump to learn whose turn the CLI opened (Artemis: 500 ms). */
  readonly decisionSettleMs: number;
  /** How long an idle, released process is kept for the next run; 0 lets it go at once. */
  readonly idleMs: number;
}

/** The tools that leave a job in the process that only fires while it idles (Artemis's list): a process that called one is kept. */
const SCHEDULING_TOOLS: ReadonlySet<string> = new Set(["CronCreate", "ScheduleWakeup", "CronUpdate"]);

/** The tools whose prompt is a question or a plan rather than a permission (the permissions spec's kinds). */
const PROMPT_KINDS: Readonly<Record<string, PromptKind>> = { AskUserQuestion: "question", ExitPlanMode: "plan" };

export const DISPOSED_DENY_MESSAGE = "The run was stopped before this could be answered.";
export const WITHDRAWN_DENY_MESSAGE = "The provider withdrew this tool call.";
const DEFAULT_DENY_MESSAGE = "The request was denied.";

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => value !== null && typeof value === "object" && !Array.isArray(value);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

/** A message that says the turn has begun without naming its owner: the model speaking on the main thread, or the turn's result. */
const speaksWithoutOwner = (message: unknown): boolean => {
  if (!isRecord(message) || message["parent_tool_use_id"] != null) return false;
  if (message["type"] === "result" || message["type"] === "assistant") return true;
  return message["type"] === "stream_event" && isRecord(message["event"]) && message["event"]["type"] !== "ping";
};

const isInit = (message: unknown): boolean => isRecord(message) && message["type"] === "system" && message["subtype"] === "init";

/** A user message as the streaming input takes it, stamped with the harness's message id. */
const userMessage = (message: PromptMessage): SDKUserMessage => {
  const images = message.attachments.filter((attachment) => attachment.kind === "image");
  const content: SDKUserMessage["message"]["content"] =
    images.length === 0
      ? message.text
      : [
          // Images before the text: a question placed after its image is answered better.
          ...images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mediaType as "image/png", data: Buffer.from(image.data).toString("base64") },
          })),
          ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
        ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: message.messageId as NonNullable<SDKUserMessage["uuid"]> };
};

/** What a spawn fixed, which a later run must share to attach. */
interface SpawnKey {
  readonly directory: string | null;
  readonly trusted: boolean;
  readonly toolServers: string;
  readonly bypassAllowed: boolean;
}

const spawnKeyOf = (input: RunInput, mode: ClaudeMode): SpawnKey => ({
  directory: input.account.directory,
  trusted: input.trusted,
  toolServers: input.toolServers.map((server) => server.name).join("\n"),
  bypassAllowed: mode === "bypassPermissions",
});

/** What the process last applied, so an attached run sends only what differs. */
interface Applied {
  model: string;
  mode: ClaudeMode;
  effort: string | null;
}

export class ClaudeProcess implements TurnControl {
  readonly sessionId: string;
  readonly #deps: ProcessDeps;
  readonly #prompts = new AsyncQueue<SDKUserMessage>("prompt pump");
  readonly #abort = new AbortController();
  readonly #ledger: TaskLedger;
  readonly #spawn: SpawnKey;
  #applied: Applied;
  #context: RunContext;
  #query: Query | undefined;
  #providerSessionId: string | null = null;

  /** The turn the CLI is serving now. */
  #current: ClaudeTurn | undefined;
  /** Runs whose prompt is queued at the CLI, not yet opened, in order. */
  readonly #waiting: ClaudeTurn[] = [];
  /** Turns handed out and not yet released by the host. */
  readonly #unsettled = new Set<ClaudeTurn>();
  /** The messages of a turn whose owner is not known yet, from its `init`. */
  #undecided: unknown[] | undefined;
  readonly #decisionWaiters: (() => void)[] = [];
  /** Whether this CLI narrates its commands and stamps replies with their owners. */
  #narrates = false;
  /** Whether the CLI has opened any turn on this process yet. */
  #anyOpened = false;
  /** Whether the spawn resumed nothing, so its first turn can only be its own run's. */
  readonly #spawnedFresh: boolean;
  /** Turns opened for a subagent's prompt between the CLI's turns, with no turn of the CLI's behind them. */
  readonly #forPrompt = new WeakSet<ClaudeTurn>();

  /** Messages sent during a turn, by id, that no turn has been seen to read yet. */
  readonly #pendingSends = new Set<string>();
  /** The permission table: prompts parked on the broker, by prompt id, answerable here too, with the turn that asked. */
  readonly #permissions = new Map<string, { readonly answer: (decision: PromptDecision) => void; readonly turn: ClaudeTurn }>();

  /** Live background tasks, from the level alone (Artemis: retention reads the level, never the ledger). */
  #liveTasks = 0;
  #registeredSchedule = false;
  #settling = false;
  #settleOwed = false;
  #settleTimer: Timer | undefined;
  #awaitingQueuedTurn = false;
  #queuedTurnTimer: Timer | undefined;
  #idleTimer: Timer | undefined;

  #closed = false;
  #disposing: Promise<void> | undefined;

  constructor(first: RunInput, context: RunContext, deps: ProcessDeps) {
    const mode = claudeMode(first.mode);
    this.sessionId = first.sessionId;
    this.#deps = deps;
    this.#context = context;
    this.#ledger = new TaskLedger(deps.clock);
    this.#spawn = spawnKeyOf(first, mode);
    this.#spawnedFresh = first.target.kind !== "resume";
    this.#applied = { model: first.model, mode, effort: first.effort };
  }

  get closed(): boolean {
    return this.#closed || this.#disposing !== undefined;
  }

  /** Whether the process has a turn open or waiting, or work a turn boundary must not kill. */
  get busy(): boolean {
    return this.#current !== undefined || this.#waiting.length > 0 || this.#undecided !== undefined || this.#liveTasks > 0 || this.#registeredSchedule;
  }

  /** Whether a run can be served on this process rather than a fresh one. */
  canServe(input: RunInput): boolean {
    if (this.closed || this.#current !== undefined || this.#waiting.length > 0 || this.#undecided !== undefined) return false;
    if (input.target.kind !== "resume" || input.target.providerSessionId !== this.#providerSessionId) return false;
    const key = spawnKeyOf(input, claudeMode(input.mode));
    if (key.directory !== this.#spawn.directory || key.trusted !== this.#spawn.trusted || key.toolServers !== this.#spawn.toolServers) return false;
    // Bypass needs the SDK's opt-in at spawn; a process started without it cannot enter bypass.
    return !key.bypassAllowed || this.#spawn.bypassAllowed;
  }

  /** The first run: spawns the CLI behind the turn's stream, and answers the turn at once. */
  open(input: RunInput): ClaudeTurn {
    const turn = this.#runTurn(input);
    void this.#start(input, turn);
    return turn;
  }

  /** A later run on the live process: moves it onto the run's model, mode and effort, then queues the prompt. */
  attach(input: RunInput, context: RunContext): ClaudeTurn {
    this.#context = context;
    this.#idleTimer?.cancel();
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
      for (const message of input.prompt) this.#prompts.push(userMessage(message));
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
    });
    this.#waiting.push(turn);
    this.#unsettled.add(turn);
    return turn;
  }

  /** Ends a run that never opened. */
  #waitingEnds(turn: ClaudeTurn, end: Omit<RunEnd, "type">): void {
    const at = this.#waiting.indexOf(turn);
    if (at !== -1) this.#waiting.splice(at, 1);
    turn.end(end);
    this.#maybeLetGo();
  }

  async #apply(input: RunInput): Promise<void> {
    const query = this.#query;
    if (query === undefined) return;
    const mode = claudeMode(input.mode);
    const effort = claudeEffort(input.effort);
    if (input.model !== this.#applied.model) await query.setModel(input.model);
    if (mode !== this.#applied.mode) await query.setPermissionMode(mode);
    if (input.effort !== this.#applied.effort) await query.applyFlagSettings({ effortLevel: effort });
    this.#applied = { model: input.model, mode, effort: input.effort };
  }

  /** Where a fork from a message or a rewind re-enters the stored chain; null for any other run. */
  async #resumePoint(input: RunInput): Promise<ResumePoint | null> {
    const target = input.target;
    const anchor = target.kind === "rewind" ? target.toMessageId : target.kind === "fork" ? target.atMessageId : null;
    if (anchor === null || target.kind === "fresh" || target.kind === "resume") return null;
    const stored = await readStoredSession({
      queue: this.#deps.queue,
      directory: input.account.directory,
      providerSessionId: target.providerSessionId,
      sessionStore: this.#deps.sessionStore,
      getSessionMessages: sdkGetSessionMessages,
    });
    const point = target.kind === "rewind" ? resolveRewindPoint(stored, anchor) : resolveForkPoint(stored, anchor);
    if (point === null) throw new Error(`The message ${anchor} is not in the stored conversation, or nothing comes before it; a rewind to the first message is a new session.`);
    return point;
  }

  async #start(input: RunInput, turn: ClaudeTurn): Promise<void> {
    let options: Options;
    try {
      options = buildRunOptions({
        run: input,
        hostEnv: this.#deps.hostEnv,
        executablePath: this.#deps.executablePath(),
        pluginDirectory: this.#deps.pluginDirectory(input),
        autoMemoryDirectory: this.#deps.autoMemoryDirectory(input),
        checkoutRoot: worktreeCheckout(input.workspace.path),
        sessionStore: this.#deps.sessionStore,
        resumePoint: await this.#resumePoint(input),
        canUseTool: this.#canUseTool,
        abortController: this.#abort,
        stderr: (data) => this.#deps.diagnostic(`Claude (session ${this.sessionId}): ${data.trimEnd()}`),
      });
      if (this.closed) throw new Error("The run was let go before its process started.");
      if (turn.ended) {
        // Interrupted while the process was being prepared: nothing is spawned for it.
        this.#close();
        return;
      }
      for (const message of input.prompt) this.#prompts.push(userMessage(message));
      this.#query = sdkQuery({ prompt: this.#prompts, options });
    } catch (error) {
      this.#waitingEnds(turn, { reason: "error", error: { message: describe(error), code: "launch" } });
      this.#close();
      return;
    }
    void this.#pump(this.#query);
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
      this.#close();
    }
  }

  /** What a message says about the process, before any turn sees it: the live tasks, a settle, a rate-limit verdict. */
  #observe(message: unknown): void {
    const verdict = readRateLimit(message);
    if (verdict !== null) this.#deps.onRateLimit(verdict);
    if (!isRecord(message) || message["type"] !== "system" || message["subtype"] !== "background_tasks_changed" || !Array.isArray(message["tasks"])) return;
    const had = this.#liveTasks > 0;
    this.#liveTasks = message["tasks"].length;
    // The empty set arrives a beat before the provider's turn about the work that finished: hold for it.
    if (had && this.#liveTasks === 0) this.#awaitSettleTurn();
  }

  #route(message: unknown): void {
    if (this.#undecided !== undefined) {
      this.#undecided.push(message);
      const owners = ownersOf(message);
      if (owners.length > 0) this.#decide(owners);
      // The first turn of a spawn that resumed nothing is its own run's: no work of an earlier process can be answered ahead of it.
      // A result naming nobody before any turn opened is the spawn's run failing to start, whatever it resumed.
      else if (!this.#anyOpened && this.#waiting.length > 0 && (this.#spawnedFresh ? speaksWithoutOwner(message) : isRecord(message) && message["type"] === "result")) {
        this.#decide("first-waiting");
      } else if (speaksWithoutOwner(message)) this.#decide([]);
      return;
    }
    // A turn opened for a subagent's prompt between turns has no turn of the CLI's behind it: the next `init` ends it.
    if (isInit(message) && this.#current !== undefined && this.#forPrompt.has(this.#current)) {
      this.#current.end({ reason: "completed" });
      this.#current = undefined;
      this.#afterTurn(false);
    }
    if (this.#current === undefined) {
      if (isInit(message)) {
        this.#undecided = [message];
        const capabilities = isRecord(message) ? message["capabilities"] : undefined;
        if (Array.isArray(capabilities)) this.#narrates = capabilities.includes("msg_lifecycle_v1");
        if (!this.#narrates) this.#decide(this.#waiting.length > 0 ? "first-waiting" : []);
        return;
      }
      // Between turns: the ledger still reads what the work that outlived the turn says.
      this.#ledger.observe(message);
      return;
    }
    this.#serve(this.#current, message);
  }

  /** Maps a message onto the open turn, noting a steer it read and a schedule it registered, and closes the turn at its end. */
  #serve(turn: ClaudeTurn, message: unknown): void {
    for (const owner of ownersOf(message)) {
      if (!this.#pendingSends.delete(owner)) continue;
      turn.emit({ type: "message.delivered", payload: { messageId: owner, delivery: "steered" } });
    }
    for (const event of turn.map(message)) {
      if (event.type === "tool.started" && SCHEDULING_TOOLS.has(event.payload.name)) this.#registeredSchedule = true;
    }
    if (turn.state.providerSessionId !== null) this.#providerSessionId = turn.state.providerSessionId;
    // Work that changed between turns is reported by the next turn to hear anything (Artemis's `#flushTasks`).
    if (!turn.ended && this.#ledger.dirty) turn.emit({ type: "tasks.changed", payload: { tasks: this.#ledger.snapshot() } });
    if (turn.ended && this.#current === turn) {
      this.#current = undefined;
      this.#afterTurn(isRecord(message) && message["type"] === "result");
    }
  }

  /**
   * Opens the turn the held messages belong to: the waiting run whose prompt
   * the owners name (or the first waiting run, for a CLI that does not
   * narrate), else a turn of the provider's own, handed to the adoption hook
   * with the sent messages it opened with. Then the held messages are served.
   */
  #decide(owners: readonly string[] | "first-waiting"): void {
    const held = this.#undecided ?? [];
    this.#undecided = undefined;
    this.#anyOpened = true;
    const named = owners === "first-waiting" ? [] : owners;
    const at = owners === "first-waiting" ? (this.#waiting.length > 0 ? 0 : -1) : this.#waiting.findIndex((turn) => turn.promptIds.some((id) => named.includes(id)));
    const opened = named.filter((id) => this.#pendingSends.delete(id));
    if (at !== -1) {
      const turn = this.#waiting.splice(at, 1)[0] as ClaudeTurn;
      turn.opened = true;
      this.#current = turn;
      // Sent messages the CLI folded into this run's opening turn were read by it.
      for (const messageId of opened) turn.emit({ type: "message.delivered", payload: { messageId, delivery: "prompt" } });
    } else this.#providerTurn(opened);
    this.#settleWaiters();
    for (const message of held) this.#route(message);
  }

  /** A turn the provider opened on its own, adopted by the host as a run of the session. */
  #providerTurn(messageIds: readonly string[]): ClaudeTurn {
    const turn = new ClaudeTurn({ origin: "provider", runId: "", promptIds: [], messageIds, control: this, clock: this.#deps.clock, ledger: this.#ledger });
    turn.opened = true;
    this.#current = turn;
    this.#unsettled.add(turn);
    // A turn opening ends the settle grace's wait; its end re-arms it while the debt is owed.
    this.#settling = false;
    this.#settleTimer?.cancel();
    this.#awaitingQueuedTurn = false;
    this.#queuedTurnTimer?.cancel();
    this.#deps.diagnostic(`Claude (session ${this.sessionId}): the provider opened a turn of its own${messageIds.length > 0 ? ` with ${messageIds.length} queued message(s)` : ""}.`);
    this.#context.adopt(turn);
    return turn;
  }

  /** A turn ended: hold the process for what is coming (a queued turn, the turn about settled work), else let it go once released. */
  #afterTurn(atResult: boolean): void {
    if (this.#settleOwed && atResult) this.#awaitSettleTurn();
    if (this.#pendingSends.size > 0) {
      this.#awaitingQueuedTurn = true;
      this.#queuedTurnTimer?.cancel();
      this.#queuedTurnTimer = this.#deps.clock.setTimeout(() => {
        // No turn opened: the messages were folded in without a word on the stream.
        this.#awaitingQueuedTurn = false;
        this.#pendingSends.clear();
        this.#maybeLetGo();
      }, this.#deps.timings.queuedTurnGraceMs);
    }
    this.#maybeLetGo();
  }

  #awaitSettleTurn(): void {
    this.#settleOwed = true;
    this.#settling = true;
    this.#settleTimer?.cancel();
    if (this.#current !== undefined) return;
    this.#settleTimer = this.#deps.clock.setTimeout(() => {
      this.#settling = false;
      this.#settleOwed = false;
      this.#maybeLetGo();
    }, this.#deps.timings.settleGraceMs);
  }

  /** Whether something a turn boundary must not kill is running or owed. */
  #holdsWork(): boolean {
    return this.#liveTasks > 0 || this.#registeredSchedule || this.#settling || this.#awaitingQueuedTurn || this.#permissions.size > 0;
  }

  /** Lets the process go when no turn is open, waiting or unreleased and nothing holds it; after the idle time when one is set. */
  #maybeLetGo(): void {
    if (this.closed || this.#current !== undefined || this.#waiting.length > 0 || this.#undecided !== undefined || this.#unsettled.size > 0 || this.#holdsWork()) return;
    this.#idleTimer?.cancel();
    if (this.#deps.timings.idleMs <= 0) {
      this.#close();
      return;
    }
    this.#idleTimer = this.#deps.clock.setTimeout(() => this.#maybeLetGoNow(), this.#deps.timings.idleMs);
  }

  #maybeLetGoNow(): void {
    if (this.closed || this.#current !== undefined || this.#waiting.length > 0 || this.#undecided !== undefined || this.#unsettled.size > 0 || this.#holdsWork()) return;
    this.#close();
  }

  /** Takes the transport down; the pump's own ending does the rest. */
  #close(): void {
    if (!this.#closed) this.#deps.diagnostic(`Claude (session ${this.sessionId}): letting the process go.`);
    this.#closed = true;
    this.#idleTimer?.cancel();
    this.#settleTimer?.cancel();
    this.#queuedTurnTimer?.cancel();
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
   * `canUseTool`, on the broker seam: every request is handed to the host's
   * broker (the auto-deny placeholder until #130) and parked in the
   * permission table until the broker or `answerPrompt` settles it, or the
   * provider withdraws it. A request arriving with no turn open is a
   * subagent's, parked long after its own turn ended: a turn of the
   * provider's own is opened for it, so somebody can see it.
   */
  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    const toolUseID = options.toolUseID;
    if (this.closed) return { behavior: "deny", message: DISPOSED_DENY_MESSAGE, toolUseID };
    await this.#decided();
    let turn = this.#current;
    if (turn === undefined) {
      turn = this.#providerTurn([]);
      this.#forPrompt.add(turn);
    }
    const promptId = toolUseID === "" ? randomUUID() : toolUseID;
    const kind = PROMPT_KINDS[toolName] ?? "permission";
    const detail = toJson({
      promptId,
      toolName,
      input,
      toolUseId: toolUseID,
      title: options.title ?? null,
      description: options.description ?? null,
      decisionReason: options.decisionReason ?? null,
      blockedPath: options.blockedPath ?? null,
      agentId: options.agentID ?? null,
    }) as Record<string, unknown>;
    let answer!: (decision: PromptDecision) => void;
    const answered = new Promise<PromptDecision>((resolve) => (answer = resolve));
    this.#permissions.set(promptId, { answer, turn });
    const withdrawn = (): void => answer({ decision: "deny", message: WITHDRAWN_DENY_MESSAGE });
    options.signal.addEventListener("abort", withdrawn, { once: true });
    try {
      const decision = await Promise.race([answered, this.#context.broker.request({ sessionId: this.sessionId, runId: turn.runId, kind, detail })]);
      const result: PermissionResult =
        decision.decision === "allow"
          ? { behavior: "allow", updatedInput: input, toolUseID }
          : { behavior: "deny", message: decision.message ?? DEFAULT_DENY_MESSAGE, toolUseID };
      return result;
    } catch (error) {
      return { behavior: "deny", message: `The request could not be asked: ${describe(error)}`, toolUseID };
    } finally {
      options.signal.removeEventListener("abort", withdrawn);
      this.#permissions.delete(promptId);
      this.#endPromptTurn(turn);
      this.#maybeLetGo();
    }
  };

  /** A turn opened only to carry a subagent's prompts ends once none of them is parked: no result of the CLI's will end it. */
  #endPromptTurn(turn: ClaudeTurn, end: Omit<RunEnd, "type"> = { reason: "completed" }): void {
    if (!this.#forPrompt.has(turn) || turn.ended) return;
    if ([...this.#permissions.values()].some((parked) => parked.turn === turn)) return;
    turn.end(end);
    if (this.#current === turn) {
      this.#current = undefined;
      this.#afterTurn(false);
    }
  }

  #denyAll(message: string, only?: ClaudeTurn): void {
    for (const [promptId, parked] of [...this.#permissions]) {
      if (only !== undefined && parked.turn !== only) continue;
      parked.answer({ decision: "deny", message });
      this.#permissions.delete(promptId);
    }
  }

  // The turn control: what a turn asks of its process.

  async send(turn: ClaudeTurn, message: PromptMessage): Promise<void> {
    if (this.closed || this.#prompts.closed) throw new Error("The Claude process is closing and takes no more messages.");
    if (turn.ended) throw new Error("The run has ended; its messages go to the next run.");
    // Stamped with the harness's id: the CLI names it when a turn reads it, and an interrupt's receipt lists it.
    this.#pendingSends.add(message.messageId);
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
    // A run whose prompt the CLI has not taken yet is withdrawn from its queue, and ends there.
    if (!turn.opened && query !== undefined && (await this.#cancelAll(query, turn.promptIds))) {
      this.#waitingEnds(turn, { reason: "interrupted", cause: "user" });
      return { stillQueued: [] };
    }
    if (query === undefined) {
      this.#waitingEnds(turn, { reason: "interrupted", cause: "user" });
      return { stillQueued: [] };
    }
    let stillQueued: readonly string[];
    try {
      const receipt = await this.#within(query.interrupt(), this.#deps.timings.interruptTimeoutMs);
      stillQueued = receipt?.still_queued ?? [];
    } catch (error) {
      // The control channel did not answer: the transport comes down and the pump ends the turn interrupted.
      this.#deps.diagnostic(`Claude (session ${this.sessionId}): the interrupt did not complete; forcing the process down.`, describe(error));
      this.#abort.abort();
      this.#close();
      return { stillQueued: [] };
    }
    // The receipt names what the CLI would still run; each is withdrawn from its queue, and only those are handed back.
    const reowned: string[] = [];
    for (const id of stillQueued) {
      if (!this.#pendingSends.has(id)) continue;
      if (await this.#cancelAll(query, [id])) {
        this.#pendingSends.delete(id);
        reowned.push(id);
      }
    }
    return { stillQueued: reowned };
  }

  /**
   * Withdraws queued messages by id through the cancel-by-id control. The
   * pinned 0.3.281 declares the control request (`cancel_async_message`)
   * and its `Query` has the method at run time without declaring it, so it
   * is looked up; absent, nothing is withdrawn and the CLI runs what it holds.
   */
  async #cancelAll(query: Query, ids: readonly string[]): Promise<boolean> {
    const cancel = (query as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage;
    if (typeof cancel !== "function" || ids.length === 0) return false;
    let all = true;
    for (const id of ids) {
      try {
        if ((await cancel.call(query, id)) !== true) all = false;
      } catch {
        all = false;
      }
    }
    return all;
  }

  answerPrompt(promptId: string, decision: PromptDecision): void {
    const parked = this.#permissions.get(promptId);
    if (parked === undefined) throw new Error(`No prompt ${promptId} is parked on this run.`);
    parked.answer(decision);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.#query?.stopTask(taskId);
  }

  release(turn: ClaudeTurn): void {
    this.#unsettled.delete(turn);
    this.#maybeLetGo();
  }

  /** Stops the process now: the host has let a run go (its session deleted, the environment closing). */
  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#denyAll(DISPOSED_DENY_MESSAGE);
      for (const turn of [this.#current, ...this.#waiting]) turn?.close();
      this.#current = undefined;
      this.#waiting.length = 0;
      this.#undecided = undefined;
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
