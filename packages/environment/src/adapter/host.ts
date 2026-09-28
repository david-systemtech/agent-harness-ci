import { randomUUID } from "node:crypto";
import {
  ContractError,
  SESSION_STREAM_KIND,
  lowerMode,
  type AdapterCapabilityFlag,
  type IssueInput,
  type JsonObject,
  type MessageDeliveredPayload,
  type MessageRequeuedPayload,
  type MessageWithdrawnPayload,
  type Mode,
  type ProcessStopReason,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  type ProviderProcess,
  type RunEndedPayload,
  type RunPolicy,
  type RunStartedPayload,
  type SessionTitleSetPayload,
  type Workspace,
} from "@agent-harness/contracts";
import type { HostAccounts } from "../accounts/account-service.js";
import { formatActor, type EventEnvelope, type EventLog, type EventInput } from "../event-log/event-log.js";
import { runContainment, temporaryContainmentDirectories, type ContainmentDirectories } from "../permissions/containment-directories.js";
import { createToolGate, type GatedRun } from "../permissions/gate.js";
import {
  DUPLICATE_PROMPT_MESSAGE,
  RUN_ENDED_MESSAGE,
  STOPPED_MESSAGE,
  UNRECORDED_MESSAGE,
  CANCELLED_MESSAGE,
  autoDenial,
  nextRunText,
  openedPayload,
  ruledAnswer,
  type BrokerAnswer,
  type UnopenedReason,
} from "../permissions/broker.js";
import { answersFor, hasKeptAnswer, parkedPromptsOfRun } from "../permissions/prompts-store.js";
import { readRunPolicy } from "../permissions/review-store.js";
import { actorOfPolicy, type RunActor } from "../permissions/resolver.js";
import { answerEvents, runToolCalls, type RunToolCalls } from "../permissions/tool-decisions.js";
import {
  environmentQueue,
  latestRun,
  messageCeilings,
  providerHeld,
  readRun,
  readSessionFacts,
  type QueuedMessage,
} from "../runs/run-reads.js";
import {
  decideStart,
  originOfActor,
  policyResolvedEvent,
  type AccountFacts,
  type LiveRunFacts,
  type PlannedRun,
  type QueuedSend,
  type StartFacts,
} from "../runs/run-decider.js";
import type { Clock } from "../serve/clock.js";
import { createRunRegistry, type MemoryRunRegistry } from "../serve/run-registry.js";
import { appendRunEvents } from "../sessions/activity-companions.js";
import type { ProviderTranscripts, TranscriptDeleteAnswer } from "../sessions/deletion.js";
import type { RunParameters, RunParametersCheck, RunParametersVerdict } from "../sessions/run-parameters.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { runContinuation } from "../sessions/fork-rewind.js";
import { recordProviderTitle } from "../sessions/titles.js";
import { capability, unsupported } from "./capabilities.js";
import type {
  AccountRef,
  Adapter,
  AdapterDescriptor,
  AdapterRun,
  AttachmentData,
  PermissionBroker,
  PromptDecision,
  PromptMessage,
  PromptRequest,
  ProviderCommand,
  ProviderTurn,
  RunContainment,
  RunContext,
  RunDenylist,
  RunEnd,
  UsageReading,
} from "./contract.js";
import type { AttachmentStage } from "./attachment-stage.js";
import { createProcessPool } from "./pool.js";
import { PromptClosed, WithdrawUnsupported } from "./contract.js";
import { createAdapterRegistry, type AdapterRegistry } from "./registry.js";
import { createScopedAppend, type ScopedAppend } from "./scoped-append.js";
import {
  composeInstructions,
  noAutoAnswer,
  noToolServers,
  presetPolicy,
  type InstructionComposer,
  type PolicySeam,
  type PromptAutoAnswer,
  type ToolGateRule,
  type ToolServerFactory,
} from "./seams.js";

/**
 * The adapter host (claude-adapter spec, "Modules and ownership" and "The
 * adapter contract"; ADR 0015): what stands between the adapters and the
 * rest of the environment. It holds the adapter registry, reads each run's
 * account through the account store (#134), fills the run registry the lifecycle reads
 * for idle and drain (#112), and supplies each run with its seams (tool
 * servers, composed instructions, the policy resolver) and the permission
 * broker (#130). It starts a
 * run through its adapter once the command that asked for it has committed,
 * consumes the run's event stream once, appending each event through the
 * run's scoped append and nothing else, and appends the run's one
 * `run.ended` on every path. A run belongs to the environment, not to the
 * client that started it: nothing a socket does ends one.
 *
 * Every `run.started` and `run.ended` it appends carries the companions it
 * owes the session's organisation fields, in its transaction
 * (`sessions/activity-companions.ts`). Titles go through it too: after a
 * run ends it reads the provider's title when the adapter declares
 * `titleRead` (`sessions/titles.ts` records it), and once a user title
 * commits it mirrors it to the provider when the adapter of the session's
 * latest run declares `titleWrite`, best effort and never read back.
 *
 * The broker (permissions spec, "Modules"; ADR 0006, ADR 0007): a run's
 * request is recorded as `prompt.opened` on the session's stream, correlated
 * to the run, in a transaction of its own as the ask reaches the host, and
 * the run is parked until it is answered. A person's answer
 * (`permissions.prompts.answer`) reaches the run through `deliverAnswer`
 * once it has committed: through the adapter's `answerPrompt` and the
 * request itself. A run that ends on its own (its adapter's end, or an
 * error the host records) closes its open prompts with `prompt.answered`,
 * `auto: run_ended`, in the transaction of its `run.ended`; a run the host
 * stops (parked, an admin's stop, a deletion, a drain, the environment
 * closing) and the recovery sweep's `restart` leave them open in the log
 * (ADR 0007), denied in memory only, and an answer given later is kept for
 * the session's next run, which reads it as its first message.
 *
 * The tool decisions (#131, `permissions/tool-decisions.ts`): the host is
 * the one place that sees every event a run reports, so it records each
 * tool call's one `tool.decision` that no prompt's answer makes: the
 * provider's denial report as it comes, a call that ended `ok` unasked as
 * the mode's in the transaction of its `tool.ended`, and every call still
 * undecided as the mode's in the transaction of the run's `run.ended`. Every
 * answer it appends to a prompt (a rule's, `run_ended`, `cancelled`) carries
 * the call's decision beside it. A prompt a rule does not answer at once has
 * its `ttlExpiresAt` fixed from the TTL setting when it opens.
 *
 * The tool gate (#132, `RunContext.gate`): each run is handed a gate that
 * asks the environment's rules in order before the provider's own
 * evaluation, under the session's run live at the time. A rule asks a
 * person through the same broker, as a prompt of the run's; the host hands
 * the answer to the gate that asked and never to the adapter's
 * `answerPrompt`, since the adapter did not raise it.
 */

/** An unattended run's projection when the host has no denylist to read. */
const NOTHING_TO_PROJECT: RunDenylist = { paths: [], exempt: [], commandPatterns: [] };

export interface AdapterHostOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The run registry the lifecycle reads; preset: a fresh one on `clock`. */
  readonly runs?: MemoryRunRegistry;
  readonly adapters?: readonly Adapter[];
  /**
   * The accounts runs go through: the account store (`accounts/`), which
   * says whether an account is signed in, as whom, with what models, and
   * which is the environment's default.
   */
  readonly accounts: HostAccounts;
  readonly toolServers?: ToolServerFactory;
  readonly instructions?: InstructionComposer;
  /** The broker's automatic answers (#131); preset: none, every prompt parks. */
  readonly autoAnswer?: PromptAutoAnswer;
  /** The tool gate's rules, asked in order for every call a run's adapter checks (#132); preset: none, every call goes on to the provider. */
  readonly gateRules?: readonly ToolGateRule[];
  /**
   * The denylist as a provider projects it onto its own deny rules, read as
   * each unattended run starts (#140; an attended run is handed none).
   * Preset: nothing to project; the environment reads its denylist.
   */
  readonly providerDenylist?: () => RunDenylist;
  /**
   * How long a prompt may wait for a person before the TTL's sweeper denies
   * it, in milliseconds, read as each prompt opens; null for never (#131).
   * Preset: never; the environment passes `permissions.parkedPrompt.ttl`.
   */
  readonly promptTtlMs?: () => number | null;
  /** The policy resolver runs start through; preset: the resolver on the settings' presets. */
  readonly resolvePolicy?: PolicySeam;
  /**
   * Where a contained run may write beside its workspace: each session's
   * scratch and temporary directories (#133). Preset: a root of the host's
   * own, made with `mkdtemp` on first use and removed when the host closes;
   * the environment keeps them under its data directory.
   */
  readonly containmentDirectories?: ContainmentDirectories;
  /**
   * A client session's ceiling as it is now, which a run the environment
   * starts after another (from its queue, or a turn the provider opened) is
   * resolved under, so a ceiling changed since applies; undefined once the
   * client session is revoked or expired, and such a run is not started.
   */
  readonly ceilingOf: (clientSessionId: string) => Mode | undefined;
  /**
   * The idle time of a provider process, in minutes (`providers.processIdleMinutes`),
   * read each time a wait begins. Preset: the setting's preset; the
   * environment passes the settings store's value.
   */
  readonly processIdleMinutes?: () => number;
  /** How long closing waits, on the clock, for the provider processes to stop before it kills the rest. Preset: `PROCESS_STOP_TIMEOUT_MS`. */
  readonly processStopTimeoutMs?: number;
  /**
   * The bytes of queued messages' attachments the host starts with, by
   * message id: what the recovery sweep read back from the stage
   * (`recoverStagedAttachments`). Preset: a fresh map.
   */
  readonly stagedAttachments?: Map<string, StagedAttachments>;
  /**
   * Where those bytes are kept on disk until a run reads them, so a restart
   * keeps them (`attachment-stage.ts`); the map is the fast path, the stage
   * what a restart reads. Preset: none, the bytes in memory alone, for a host
   * with no data directory.
   */
  readonly attachmentStage?: AttachmentStage;
}

/** The attachments of one message waiting to be read, with the session it was sent to. Never logged. */
export interface StagedAttachments {
  readonly sessionId: string;
  readonly attachments: readonly AttachmentData[];
}

/** A live run as the host reports it. */
export interface ActiveRun {
  readonly runId: string;
  readonly sessionId: string;
}

export interface AdapterHost {
  readonly adapters: AdapterRegistry;
  /** The runs the lifecycle's idle rule and drain read (#112), filled as runs start and end. */
  readonly runs: MemoryRunRegistry;
  /** The runs live now, one per session at most. */
  activeRuns(): readonly ActiveRun[];
  /** The account `id` names, or the default account for null; null when the environment does not hold it. */
  account(id: string | null): AccountFacts | null;
  /** The check `sessions.create` delegates its account, model and mode to. */
  readonly validateSessionInput: RunParametersCheck;
  /** The transcript delete a purge calls (#118), routed to the session's adapter; absent when no adapter declares it. */
  readonly transcripts: ProviderTranscripts;
  /**
   * A subagent's transcript, read on demand from the session's adapter
   * (`subagentTranscripts`, #137) and never logged; refused `invalid_params`,
   * reason `unsupported`, when the adapter cannot.
   */
  subagentTranscript(sessionId: string, agentId: string): Promise<readonly JsonObject[]>;
  /** Throws `unavailable` while the environment drains: the gate every new run passes. */
  admit(): void;
  /** What starting a run on the session for `actor` depends on, read now (inside a command, in its transaction). */
  startFacts(sessionId: string, actor: RunActor): StartFacts;
  /** The session's live run and its adapter's descriptor; null when none is live. */
  live(sessionId: string): LiveRunFacts | null;
  /**
   * The run the session counts as live, as a start does (`startFacts`): its
   * live run, or, while a turn its provider opened after that run's end waits
   * on its mode change, the run it followed, since the turn is then adopted
   * as a run or let go with its messages requeued. Null when neither.
   */
  runActive(sessionId: string): LiveRunFacts | null;
  /** The live run `runId` names; null once it has ended. */
  liveRun(runId: string): LiveRunFacts | null;
  /** Whether the run ended here with its `run.ended` not in the log (two appends failed): the recovery sweep (#120) records it at the next start. */
  unrecorded(runId: string): boolean;
  /** Starts a run its command committed: through its adapter, its events consumed from here on. */
  launch(run: PlannedRun): void;
  /**
   * Stages on disk the attachments of a message about to be queued, inside
   * the command that queues it and before it answers, so its receipt means
   * the bytes are safe. Throws `internal` when they cannot be staged: the
   * send is refused, nothing of it recorded and no receipt kept.
   */
  stageAttachments(message: PromptMessage): void;
  /** Hands a message sent during a live run to its provider, or holds it for the next run, once its event committed. */
  queue(send: QueuedSend): void;
  /**
   * Starts the session's next run for an answer an automatic rule kept for
   * it (#131: the TTL's, whose run had gone), so the session continues on
   * its own: the run reads the answer first, then whatever is queued, for
   * the actor of the run before it, resolved afresh. Nothing when a run is
   * live on the session (the answer waits for the run after it), the session
   * has never run or is deleted, the environment drains or closes, or no
   * answer is kept any more. A person's answer starts nothing (#130).
   */
  continueSession(sessionId: string): void;
  /**
   * Interrupts a live run with cancel; the messages its provider still held
   * come back to the environment's queue. After a read-now on the run it is
   * the last word: the run ends with cause `user`, and no run of the queue starts.
   */
  interrupt(runId: string): void;
  /**
   * Reads the session's queue now (ADR 0022, #228), once the command that
   * asked has committed: interrupts its live run with cause `read-now`, takes
   * back what the provider still held, and once the run's end is recorded
   * starts the next run with the environment's whole queue, for `actor`
   * under its ceiling as it is then and each queued sender's. An interrupt
   * already under way is waited on rather than made again; a second read-now
   * on the run changes nothing; a later `interrupt` cancels the read-now.
   */
  readNow(sessionId: string, actor: RunActor): void;
  /**
   * Asks the provider holding the session's queue to take message
   * `messageId` back (`withdraw`, ADR 0022, #228), through the session's live
   * run. When it did, the message comes back to the environment's queue at
   * once (`message.requeued`, in a transaction of its own, as an
   * interrupt's return does), so the command that asked withdraws an
   * environment-held message, and a command that fails or is answered from
   * another's receipt leaves it queued and visible, never lost. When the
   * provider no longer holds it while the run's interrupt is under way, the
   * interrupt may have taken it: the answer waits for the interrupt, and the
   * message is kept out of any run the interrupt's end starts until the
   * command has decided. False when it read it, or with no run live to ask
   * (a turn the provider opened with it is being adopted). Refused
   * `invalid_params`, reason `unsupported`, when the run's adapter cannot
   * take a message back, and `internal` when it cannot say.
   */
  withdraw(sessionId: string, messageId: string): Promise<{ readonly withdrawn: boolean }>;
  /**
   * What the session's next run is started from when the environment
   * starts it after another (a run of the queue, a read-now with no run
   * live, #228): the run before it, as this host last ended it, else as the
   * log records it; null when the session has never run.
   */
  nextRunBasis(sessionId: string): NextRunBasis | null;
  /** The withdraw of `messageId` has decided: a run may read the message again if it is still queued (#228). */
  settleWithdraw(messageId: string): void;
  /**
   * Whether the host may still hand a message back to the session's queue
   * after its run's `run.ended` has committed (#245): an interrupt whose
   * answer has not come (the turn can complete first, and the answer then
   * names what the provider held), or a send or a withdraw its provider has
   * not answered. What comes back is a message the log says the provider
   * holds until it does.
   */
  handingBack(sessionId: string): boolean;
  /**
   * Settles once the session has nothing handing back (`handingBack`), work
   * begun meanwhile included, or once a run is active on it (`runActive`),
   * whose own work a rewind need not wait for, since that run refuses it.
   * A rewind waits on it, so a message handed back is in the queue its check
   * reads; it settles when the adapters' answers do (`AdapterRun`).
   */
  handedBack(sessionId: string): Promise<void>;
  /** Stops a piece of a live run's delegated work. */
  stopTask(runId: string, taskId: string): void;
  /** Changes a live run's mode through its adapter (`modeChange`), once the command that asked has committed; its resolved policy stays. */
  setMode(runId: string, mode: Mode): void;
  /** Whether the live run `runId` waits on prompt `promptId`: false once the run has ended, or the prompt was answered. */
  holdsPrompt(runId: string, promptId: string): boolean;
  /**
   * Hands a person's answer, once it has committed, to the run that waits on
   * it, the host's one answer path (#224): through its adapter's
   * `answerPrompt` when the adapter takes answers (`interactivePrompts`), and
   * by settling the broker's request, whatever the adapter says, so the run
   * is never left waiting on an answer the log holds, and no longer parked
   * on it. An approved plan's mode becomes the mode the host knows the run
   * is in. A run no longer live is handed nothing (the answer's command
   * checked it in its transaction; the log keeps the answer), and a prompt
   * the tool gate raised (#132) goes to the gate alone, by that settling,
   * never to the adapter, which did not raise it. Refused
   * `conflict` with reason `prompt_not_open` when the live run has not
   * raised the prompt or it is answered already (the host's own record,
   * checked before the adapter is asked), and with the adapter's reason
   * (`run_ended` or `prompt_not_open`) when the adapter holds it no longer:
   * thrown when the adapter answers at once, and the returned promise
   * rejected when it answers asynchronously, so the caller awaits what it
   * returns. Any other failure of the adapter's is logged and refused
   * `internal`, the same way at once or asynchronously.
   */
  deliverAnswer(runId: string, promptId: string, decision: PromptDecision): void | Promise<void>;
  /** Plan usage for an account, with its identity (`planUsage`). */
  usage(accountId: string): Promise<UsageReading>;
  /** The slash commands for an account and workspace (`commands`). */
  commands(accountId: string, workspace: Workspace): Promise<readonly ProviderCommand[]>;
  /** The adapters' descriptors, one per provider (`providers.list`). */
  providers(): readonly AdapterDescriptor[];
  /** The provider processes (`providers.processes.*`). */
  readonly processes: {
    list(): ProviderProcess[];
    /** Whether the session has a process that is not stopping or stopped. */
    running(sessionId: string): boolean;
    /** Stops the session's process for an admin: a run live on it ends `interrupted`, cause `user`, recorded as `by`'s. */
    stop(sessionId: string, by?: { readonly actor: string; readonly commandId: string }): void;
  };
  /** The environment drains: every idle process with no held work stops now, every busy one as its turn ends, a held one when its last hold is let go. */
  drain(): void;
  /**
   * Ends every live run (`disposed`, or `drained` when a drain's cap cut it),
   * stops taking events, and stops every provider process; resolves once they
   * have stopped, or once the stop timeout has passed on the clock and the
   * rest have been killed. The environment is closing.
   */
  close(reason: "disposed" | "drained"): Promise<void>;
}

/** The host's own actor, for the run events it decides on itself: an end it appends, a run it starts from the queue. */
export const HOST_ACTOR = formatActor({ kind: "system", id: "adapter-host" });

/** `message.requeued` for each message of `runId`: the environment holds it now (ADR 0022). Always the host's. */
export const requeuedEvents = (runId: string, messageIds: readonly string[]): EventInput[] =>
  messageIds.map((messageId): EventInput => {
    const payload: MessageRequeuedPayload = { runId, messageId };
    return { type: "message.requeued", payload };
  });

/**
 * What a run the environment starts after another takes from it: the
 * session, the actor, the model and effort, and the run's own instructions
 * and client tools (a completions request's, #138, #139), which the log does
 * not hold, so a run started after a restart carries neither.
 */
export type NextRunBasis = Pick<PlannedRun, "sessionId" | "actor" | "model" | "effort" | "appendedInstructions" | "clientTools">;

/**
 * Who ends a run: its adapter, whose end event is recorded; or the host,
 * which disposes the run and stops its process for `stop`'s reason, and
 * records the end as its own, or as `actor`'s under `commandId` when a
 * person's command ended it.
 */
type EndedBy =
  | { readonly by: "adapter" }
  | { readonly by: "host"; readonly stop: ProcessStopReason; readonly actor?: string; readonly commandId?: string };

/** One live run. */
interface LiveRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly descriptor: AdapterDescriptor;
  readonly plan: PlannedRun;
  readonly actor: string;
  readonly append: ScopedAppend;
  readonly startedAt: number;
  /** The mode the provider runs it in now: its policy's, until a live change (`setMode`) takes. */
  mode: Mode;
  /** Its containment, as its adapter was handed it and the gate rules under it: its policy's, fixed for the run. */
  readonly containment: RunContainment;
  run: AdapterRun | undefined;
  /**
   * Set once the host ends it, synchronously and first thing in `finish`,
   * before any await or append, so a second end (the adapter's end racing a
   * dispose, a deletion, a failed interrupt) sees it and does nothing:
   * exactly one `run.ended` per run rests on it.
   */
  ended: boolean;
  /**
   * Set when its `run.ended` could not be appended, twice: the run is over
   * here (let go, ended in the run registry, no longer the session's live
   * run, so a start is accepted and an interrupt answers `ended` with
   * `unrecorded`), while the log still has no end for it until the
   * recovery sweep (`recovery.ts`) appends one at the next start.
   */
  unrecorded: boolean;
  running: boolean;
  interrupting: boolean;
  /**
   * The interrupt under way, settled once what the provider reported still
   * queued is back in the environment's queue, or, when the interrupt failed,
   * once the host's end of the run has taken back what the provider held:
   * what a read-now and a withdraw wait on (#228).
   */
  interruption: Promise<void> | null;
  /**
   * Set by `runs.readNow` (#228): whose run of the queue starts once both the
   * interrupt has taken back what the provider held and the end is
   * recorded, and whether each has happened; its end's cause is `read-now`.
   */
  readNow: ReadNow | null;
  /** The prompts it raised that are not answered yet, by id: while any is, the run is parked. */
  readonly prompts: Set<string>;
  /** Whether its adapter was handed the run's input; until then the messages it was launched with are still the environment's. */
  received: boolean;
  /** The messages the run was launched with, bytes included. */
  readonly launchedWith: readonly PromptMessage[];
  /** Its tool calls, for the decisions no prompt's answer makes (#131). */
  readonly calls: RunToolCalls;
}

/** A read-now waiting on its run's interrupt and end (#228). */
interface ReadNow {
  readonly actor: RunActor;
  interrupted: boolean;
  ended: boolean;
  started: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs `work` and hands a promise it answers, or a throw, to `onError`; never an unhandled rejection. Answers, when
 * `work` answered a promise, one that settles once it and `onError` are done.
 */
const safely = (work: () => unknown, onError: (error: unknown) => void): Promise<void> | undefined => {
  // `onError` may throw too (a requeue whose append fails, an end whose adoption fails): that is logged, never left unhandled.
  const handle = (error: unknown): void => {
    try {
      onError(error);
    } catch (handlerError) {
      console.error("Handling a failure failed as well:", handlerError, "the failure was:", error);
    }
  };
  try {
    const answer = work();
    if (answer instanceof Promise) return answer.then(() => undefined, handle);
  } catch (error) {
    handle(error);
  }
  return undefined;
};

export const createAdapterHost = (options: AdapterHostOptions): AdapterHost => {
  const { log, clock } = options;
  const adapters = createAdapterRegistry(options.adapters ?? []);
  const registry = options.runs ?? createRunRegistry({ clock });
  const toolServers = options.toolServers ?? noToolServers;
  const instructions = options.instructions ?? composeInstructions();
  const autoAnswer = options.autoAnswer ?? noAutoAnswer;
  const gateRules = options.gateRules ?? [];
  /**
   * What an unattended run projects onto its provider's own rules, read as
   * it starts; an attended run gets none, so a person's explicit allow is
   * never blocked by a rule. A read that fails projects nothing, logged:
   * the gate still asks about every call.
   */
  const runDenylist = (attended: boolean): RunDenylist | null => {
    if (attended) return null;
    try {
      return options.providerDenylist?.() ?? NOTHING_TO_PROJECT;
    } catch (error) {
      console.error("Reading the denylist for a run's provider rules failed; the run projects none, and the gate still asks about every call:", error);
      return NOTHING_TO_PROJECT;
    }
  };
  const promptTtlMs = options.promptTtlMs ?? (() => null);
  const resolvePolicy = options.resolvePolicy ?? presetPolicy;
  const directories = options.containmentDirectories ?? temporaryContainmentDirectories();
  const { accounts } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** Live runs by session: at most one each. */
  const live = new Map<string, LiveRun>();
  /** The run each session last ended here: what a run the environment starts itself for kept answers is resolved from (#131). */
  const lastPlans = new Map<string, PlannedRun>();
  /** Runs that ended here with their end not in the log. */
  const unrecordedRuns = new Set<string>();
  /**
   * Sessions whose provider-opened turn waits for a mode change to answer
   * before it is adopted, each with the run it followed: until it answers,
   * the session counts that run as live, so a start is `run_active` and a
   * send is queued (and taken back, since the run has ended).
   */
  const changingMode = new Map<string, LiveRunFacts>();
  /** Turns a provider opened while the run before them was still live, waiting for it to end, each with the run it followed. */
  const adoptions = new Map<string, { readonly followed: LiveRun; readonly turn: ProviderTurn }[]>();
  /**
   * The bytes of the attachments of messages sent during a run, whoever
   * holds them, until a run reads them (the launch of a run of the queue, a
   * steer's `message.delivered`, an adopted turn), since an interrupt may hand
   * a provider-held message back; a purged session's are dropped. They are
   * never logged. The map is the fast path; the stage keeps them on disk
   * (`attachment-stage.ts`), written before the send that queued them answers
   * and removed as they leave the map, so after a restart the recovery sweep
   * reads them back and a message it hands back keeps its bytes.
   */
  const heldAttachments = options.stagedAttachments ?? new Map<string, StagedAttachments>();
  /**
   * The broker's open requests, by run and prompt id (`waiterKey`): each
   * run's prompts nobody has answered yet, settled by a person's answer
   * (`deliverAnswer`), the provider's cancelling it, or the run's end, which
   * denies them in memory.
   */
  const waiters = new Map<string, { readonly runId: string; settle(decision: PromptDecision): void }>();
  const waiterKey = (runId: string, promptId: string): string => `${runId}\u0000${promptId}`;
  /** The open requests the tool gate made rather than the adapter (`waiterKey`): their answers go to the gate alone. */
  const gateRequests = new Set<string>();
  const stage = options.attachmentStage;
  let closing = false;

  /**
   * By session, the work under way that may hand a message back to its
   * queue once its run's end has committed (`handingBack`, #245): an
   * interrupt's answer, a send or a withdraw the provider has not answered.
   * Each leaves once it has settled, its hand-back appended.
   */
  const handingBack = new Map<string, Set<Promise<unknown>>>();
  const track = (sessionId: string, work: Promise<unknown>): void => {
    const pending = handingBack.get(sessionId) ?? new Set<Promise<unknown>>();
    handingBack.set(sessionId, pending);
    pending.add(work);
    const done = (): void => {
      pending.delete(work);
      if (pending.size === 0 && handingBack.get(sessionId) === pending) handingBack.delete(sessionId);
    };
    work.then(done, done);
  };

  /** A run has read the message, or its session is purged: its bytes go, from memory and from disk. */
  const unstage = (messageId: string): void => {
    heldAttachments.delete(messageId);
    try {
      stage?.remove(messageId);
    } catch (error) {
      // The message is read or gone from the log by now, so the next start's reload removes them.
      console.error(`Removing the staged attachments of message ${messageId} failed; the next start removes them:`, error);
    }
  };

  /**
   * The provider processes (`pool.ts`): a run begins, answers, parks and ends
   * on its session's process; the host stops the process with every run it
   * ends itself, and ends the run of a process parked too long.
   */
  const pool = createProcessPool({
    clock,
    ...(options.processIdleMinutes !== undefined && { idleMinutes: options.processIdleMinutes }),
    ...(options.processStopTimeoutMs !== undefined && { stopTimeoutMs: options.processStopTimeoutMs }),
    stopProcess: (sessionId, provider, stopOptions) => {
      const adapter = adapters.get(provider);
      if (adapter === undefined) throw new Error(`No adapter serves the provider ${provider}.`);
      return stopOptions === undefined ? adapter.stopProcess(sessionId) : adapter.stopProcess(sessionId, stopOptions);
    },
    onParkedTooLong: (sessionId) => {
      const entry = live.get(sessionId);
      if (entry !== undefined && !entry.ended) finish(entry, { type: "end", reason: "interrupted", cause: "parked" }, { by: "host", stop: "parked" });
    },
  });

  /** The account `id` names as the account store holds it, or the default account for null. */
  const account = (id: string | null): AccountFacts | null => {
    const which = id ?? accounts.defaultId();
    return which === null ? null : accounts.facts(which);
  };

  /** An account a provider method is asked of by id: its adapter and the reference it is handed. */
  const heldAccount = (id: string): { readonly adapter: Adapter; readonly ref: AccountRef } => {
    const facts = accounts.facts(id);
    const adapter = facts === null ? undefined : adapters.get(facts.descriptor.provider);
    if (facts === null || adapter === undefined) throw new Error(`No account ${id} is on this environment.`);
    return { adapter, ref: { id, directory: facts.directory } };
  };

  /** The adapter of an account the store holds or held, by its provider. */
  const adapterOfAccount = (accountId: string | null | undefined): Adapter | undefined => {
    const provider = accountId === null || accountId === undefined ? null : accounts.providerOf(accountId);
    return provider === null ? undefined : adapters.get(provider);
  };

  /** Whether a run is still live: not ended by the host. */
  const isLive = (entry: LiveRun): boolean => !entry.ended;

  const byRunId = (runId: string): LiveRun | undefined => [...live.values()].find((entry) => entry.runId === runId && isLive(entry));

  const liveFacts = (entry: LiveRun | undefined): LiveRunFacts | null =>
    entry === undefined || !isLive(entry) ? null : { runId: entry.runId, descriptor: entry.descriptor, policy: entry.plan.policy };

  const append = (sessionId: string, runId: string, actor: string, events: readonly EventInput[], commandId?: string): void => {
    if (events.length > 0) log.append(sessionStream(sessionId), events, { actor, correlationId: runId, ...(commandId !== undefined && { commandId }) });
  };

  /**
   * Takes back into the environment's queue the messages a run was launched
   * with and its adapter never received (ADR 0022: nothing is lost), with
   * their bytes, so the next start reads them in their order.
   */
  const requeueUnread = (entry: LiveRun): void => {
    const ids = new Set(entry.launchedWith.map((message) => message.messageId));
    // Those its start recorded as read, in the order they were sent: every one, unless an earlier end took one back already.
    const read = reader
      .all<{ message_id: string }>("SELECT message_id FROM run_messages WHERE session_id = ? AND held_by = 'read' ORDER BY sequence", entry.sessionId)
      .map((row) => row.message_id)
      .filter((messageId) => ids.has(messageId));
    for (const message of entry.launchedWith) {
      if (read.includes(message.messageId) && message.attachments.length > 0) {
        heldAttachments.set(message.messageId, { sessionId: entry.sessionId, attachments: message.attachments });
        try {
          stage?.write(message.messageId, message.attachments);
        } catch (error) {
          console.error(`STAGING THE ATTACHMENTS OF MESSAGE ${message.messageId} FAILED; they are kept in memory and a restart loses them:`, error);
        }
      }
    }
    append(entry.sessionId, entry.runId, HOST_ACTOR, requeuedEvents(entry.runId, read));
  };

  /** Takes back into the environment's queue the messages of `runId` that the provider still holds, of `messageIds` or all. */
  const requeue = (sessionId: string, runId: string, messageIds?: readonly string[]): void => {
    const held = providerHeld(reader, sessionId, runId).filter((messageId) => messageIds === undefined || messageIds.includes(messageId));
    append(sessionId, runId, HOST_ACTOR, requeuedEvents(runId, held));
  };

  /**
   * Takes back the messages an interrupt reports its provider no longer
   * holds, whichever run of the session each was sent during: a provider's
   * queue is the session's, so cancelling it can return a message an earlier
   * run left with the provider (one a replaced process handed on). Each is
   * requeued under its own run, in the order sent; an id the provider does
   * not hold for the session is ignored, so one a run's end took back
   * already is not taken back again.
   */
  const requeueReported = (sessionId: string, messageIds: readonly string[]): void => {
    if (messageIds.length === 0) return;
    const held = reader
      .all<{ message_id: string; run_id: string }>("SELECT message_id, run_id FROM run_messages WHERE session_id = ? AND held_by = 'provider' ORDER BY sequence", sessionId)
      .filter((row) => messageIds.includes(row.message_id));
    log.atomically(() => {
      for (const row of held) append(sessionId, row.run_id, HOST_ACTOR, requeuedEvents(row.run_id, [row.message_id]));
    });
  };

  /**
   * Interrupts a live run with cancel, for `runs.interrupt` or a read-now:
   * what its provider reports it no longer holds comes back to the
   * environment's queue, and the interrupt's promise (`LiveRun.interruption`)
   * settles once it has, which a read-now and a withdraw wait on (#228). An
   * interrupt the adapter cannot make ends the run as the host's,
   * `interrupted`, and disposes it, and settles the promise after.
   */
  const interruptRun = (entry: LiveRun): Promise<void> => {
    const run = entry.run;
    if (entry.interruption !== null) return entry.interruption;
    if (run === undefined) return Promise.resolve();
    entry.interrupting = true;
    let settle!: () => void;
    entry.interruption = new Promise<void>((resolve) => (settle = resolve));
    // Its answer may come after the run's end, with what the provider still held: a rewind waits for it (#245).
    track(entry.sessionId, entry.interruption);
    safely(
      async () => {
        const { stillQueued } = await run.interrupt();
        // What the provider no longer holds comes back to the environment's queue, in its order (ADR 0022), this run's
        // and any an earlier run left with the provider, even when the run's end came first: the end took back this
        // run's only, and a message it took back is the environment's already, so nothing is taken back twice.
        if (!closing) requeueReported(entry.sessionId, stillQueued);
        settle();
      },
      (error) => {
        // The adapter could not interrupt: the host ends the run itself, interrupted as asked, and disposes it; its end
        // takes back what the provider held, and only then is the interrupt settled, so what waits on it reads a whole queue.
        console.error(`Interrupting run ${entry.runId} failed; the host ends it:`, error);
        try {
          finish(entry, { type: "end", reason: "interrupted", cause: "user" }, { by: "host", stop: "failed" });
        } finally {
          settle();
        }
      },
    );
    return entry.interruption;
  };

  /**
   * Messages a withdraw is deciding on while the interrupt that may have
   * taken them settles (#228): kept out of any run that starts meanwhile, so
   * a run the interrupt's end starts cannot read a message being withdrawn.
   * Each is let go once the command has decided.
   */
  const withdrawing = new Set<string>();

  /** The messages the environment holds for the session, those a withdraw is deciding on left out. */
  const queuedFor = (sessionId: string): QueuedMessage[] => environmentQueue(reader, sessionId).filter((message) => !withdrawing.has(message.messageId));

  /** Starts a read-now's run of the queue once its run's interrupt and end are both done, once (#228). */
  const startReadNow = (entry: LiveRun): void => {
    const pending = entry.readNow;
    if (pending === null || !pending.interrupted || !pending.ended || pending.started || closing) return;
    pending.started = true;
    // The run the queue would have had after this one, for the caller: its model and effort, the caller's ceiling and each sender's.
    startFromQueue({ ...entry.plan, actor: pending.actor });
  };

  /** The run the session counts as live (`AdapterHost.runActive`): a start is `run_active` while there is one. */
  const runActive = (sessionId: string): LiveRunFacts | null => liveFacts(live.get(sessionId)) ?? changingMode.get(sessionId) ?? null;

  const startFacts = (sessionId: string, actor: RunActor): StartFacts => {
    const session = readSessionFacts(log, reader, sessionId);
    const accountId = session?.account ?? accounts.defaultId();
    const facts = accountId === null ? null : accounts.facts(accountId);
    const { modelFamily, effort } = accounts.defaults();
    return {
      sessionId,
      session,
      live: runActive(sessionId),
      accountId,
      account: facts,
      queued: queuedFor(sessionId),
      // What the run continues from: the linked conversation, a rewind of it, or a fork's source's (#137).
      ...runContinuation(log, reader, sessionId, facts?.descriptor ?? null),
      actor,
      resolvePolicy,
      defaults: { modelFamily, effort },
      runId: randomUUID(),
    };
  };

  /**
   * Once a run's end has committed, reads the title the provider generated
   * for its session when the adapter declares `titleRead`, and records it as
   * the generated title unless the user has set one (`sessions/titles.ts`),
   * in a transaction of its own that names the end as its causation. Best
   * effort: a read that fails is logged, and the title stays as it was.
   */
  const readProviderTitle = (entry: LiveRun, ended: EventEnvelope | undefined): void => {
    if (!entry.descriptor.titleRead) return;
    safely(
      async () => {
        const adapter = adapterOf(entry.plan.account);
        const read = capability(entry.descriptor, "titleRead", adapter.readTitle, "read a provider title", "readTitle");
        const title = await read.call(adapter, entry.sessionId);
        if (title === null || closing) return;
        const cause = ended === undefined ? {} : { causationId: ended.eventId };
        recordProviderTitle(log, { sessionId: entry.sessionId, title }, { actor: entry.actor, correlationId: entry.runId, ...cause });
      },
      (error) => console.error(`Reading the provider's title of session ${entry.sessionId} failed:`, error),
    );
  };

  /**
   * Mirrors a user title that has committed into the provider's own title
   * field, when the adapter of the session's latest run declares
   * `titleWrite`: best effort (a failure is logged and changes nothing here)
   * and never read back. A session that has never run has no provider
   * session to title, so nothing is mirrored for it.
   */
  const mirrorTitle = (sessionId: string, title: string): void => {
    const accountId = closing ? undefined : latestRun(reader, sessionId)?.accountId;
    const adapter = adapterOfAccount(accountId);
    if (adapter === undefined || !adapter.descriptor.titleWrite) return;
    safely(
      () => capability(adapter.descriptor, "titleWrite", adapter.writeTitle, "mirror a user title", "writeTitle").call(adapter, sessionId, title),
      (error) => console.error(`Mirroring the title of session ${sessionId} to the provider failed:`, error),
    );
  };

  /**
   * Ends a run, once: appends its `run.ended`, marks it ended in the run
   * registry and lets its adapter go. `by` says who ended it: its adapter,
   * whose end event it records, or the host (a stream that failed or stopped
   * without an end, a refused event, a failed interrupt, a dispose), whose
   * end it records as its own and whose run it disposes, since its stream
   * may still be open. Unless the adapter completed the turn itself (its
   * provider then reads what it holds in a turn of its own, adopted), the
   * messages the provider still held for the run come back to the
   * environment's queue in the same transaction, heard just before the end,
   * so a client that starts a run on seeing the end finds them queued
   * (ADR 0022: nothing is lost). Then the session's next run, if one is
   * owed: a turn the provider opened meanwhile, or the environment's queue
   * after a run that completed or failed.
   *
   * The run's process goes with it (`pool.ts`): a released run leaves it
   * idle; a disposed one stops it for the host's reason, so the next run
   * starts cold, and a turn the stopped process opened meanwhile is not
   * adopted: it is let go and what it opened with queued again.
   *
   * If the end cannot be appended, it is tried once more; if that fails
   * too, the failure is logged loudly and the run is over here all the same:
   * out of the run registry, no longer the session's live run, its adapter's
   * run and its process let go as they would have been, and its waiting
   * turns dropped. The log has no end for it until the recovery sweep
   * (`recovery.ts`) appends one at the next start.
   */
  const finish = (
    entry: LiveRun,
    end: RunEnd | { readonly type: "end"; readonly reason: "disposed" | "drained" },
    ended: EndedBy,
  ): void => {
    // Synchronous, before anything else: exactly one end per run rests on this flag (see `LiveRun.ended`).
    const { by } = ended;
    if (entry.ended) return;
    entry.ended = true;
    const reason = end.reason;
    const full = end as Partial<RunEnd>;
    const payload: RunEndedPayload = {
      runId: entry.runId,
      reason,
      // The host knows it interrupted; an adapter that ends interrupted on its own names its cause, or none.
      cause: reason === "interrupted" ? (entry.interrupting ? (entry.readNow !== null ? "read-now" : "user") : (full.cause ?? null)) : null,
      error: reason === "error" ? (full.error ?? { message: "The run failed.", code: null }) : null,
      usage: full.usage === undefined || full.usage === null ? null : [...full.usage],
      durationMs: Math.max(0, clock.now().getTime() - entry.startedAt),
      turnCount: full.turnCount ?? null,
      resultText: full.resultText ?? null,
    };
    // Its adapter's end, or an error the host records, is a run ending on its own; every other end the host makes is a stop.
    const closesPrompts = ended.by === "adapter" || ended.stop === "failed";
    const letRunGo = (): void => {
      // Whatever it still waits on is denied in memory; the log keeps a stopped run's prompts open.
      denyWaiters(entry.runId, closesPrompts ? RUN_ENDED_MESSAGE : STOPPED_MESSAGE);
      if (ended.by === "host") {
        safely(() => entry.run?.dispose(), (e) => console.error(`Disposing run ${entry.runId} failed:`, e));
        void pool.stop(entry.sessionId, ended.stop);
        dropAdoptions(entry.sessionId);
      } else {
        safely(() => entry.run?.release(), (e) => console.error(`Releasing run ${entry.runId} failed:`, e));
        pool.end(entry.sessionId, entry.runId);
      }
    };
    // The end, with the companions it owes the session (a snoozed one wakes), in one transaction.
    const record = (): EventEnvelope | undefined =>
      log.atomically((tx) => {
        // A run whose adapter never had its input read none of it: what it was launched with is the environment's queue again.
        if (!entry.received) requeueUnread(entry);
        if (by === "host" || reason !== "completed") requeue(entry.sessionId, entry.runId);
        // A run that ends on its own closes its open prompts, just before its end; a run the host stops leaves them open (ADR 0007).
        if (closesPrompts) {
          for (const open of parkedPromptsOfRun(reader, entry.runId)) {
            const closed: PromptAnsweredPayload = autoDenial(open.prompt, "run_ended");
            log.append(sessionStream(entry.sessionId), answerEvents(reader, open.prompt, closed), { tx, actor: HOST_ACTOR, correlationId: entry.runId });
          }
        }
        // Every call it made that nobody was asked about and the provider did not deny: the mode let it through (#131).
        append(entry.sessionId, entry.runId, HOST_ACTOR, entry.calls.settle());
        const actor = ended.by === "adapter" ? entry.actor : (ended.actor ?? HOST_ACTOR);
        const commandId = ended.by === "host" ? ended.commandId : undefined;
        const attribution = { tx, actor, correlationId: entry.runId, ...(commandId !== undefined && { commandId }) };
        const [recorded] = appendRunEvents(log, entry.sessionId, [{ type: "run.ended", payload }], attribution);
        return recorded;
      });
    let recorded: EventEnvelope | undefined;
    try {
      try {
        recorded = record();
      } catch (first) {
        console.error(`Appending the end of run ${entry.runId} failed; trying once more:`, first);
        recorded = record();
      }
    } catch (appendError) {
      // The run is over here all the same: it leaves the registry and the session, so nothing waits on it, and
      // `runs.interrupt` answers it ended and unrecorded. The log's missing end is the recovery sweep's (#120).
      entry.unrecorded = true;
      unrecordedRuns.add(entry.runId);
      console.error(
        `THE END OF RUN ${entry.runId} OF SESSION ${entry.sessionId} COULD NOT BE APPENDED (${reason}); the log has no end for it until the recovery sweep at the next start:`,
        appendError,
      );
      registry.end(entry.runId);
      if (live.get(entry.sessionId) === entry) live.delete(entry.sessionId);
      letRunGo();
      dropAdoptions(entry.sessionId);
      return;
    }
    registry.end(entry.runId);
    if (live.get(entry.sessionId) === entry) live.delete(entry.sessionId);
    lastPlans.set(entry.sessionId, entry.plan);
    letRunGo();
    if (closing || reason === "disposed" || reason === "drained") return;
    readProviderTitle(entry, recorded);
    const [adopted, ...rest] = adoptions.get(entry.sessionId) ?? [];
    if (adopted !== undefined) {
      if (rest.length > 0) adoptions.set(entry.sessionId, rest);
      else adoptions.delete(entry.sessionId);
      adoptNow(adopted.followed, adopted.turn);
      return;
    }
    // A read-now's run of the queue, once its interrupt has taken back what the provider held too (#228).
    if (entry.readNow !== null) {
      entry.readNow.ended = true;
      startReadNow(entry);
      return;
    }
    // Not after a run that never reached its adapter: the next start, not a loop of failing ones, reads the queue it left.
    if (reason !== "interrupted" && entry.received) startFromQueue(entry.plan);
  };

  /**
   * Consumes a run's events once, in order: each is appended through the
   * scoped append; the end event ends the run; a throw, from the stream or
   * from an append that refused an event, ends it `error`; a stream that
   * stops without an end ends it `error` too. After the run has ended
   * (disposed), whatever the stream still yields is dropped.
   */
  const consume = async (entry: LiveRun, run: AdapterRun): Promise<void> => {
    try {
      for await (const event of run.events) {
        if (entry.ended) break;
        if (event.type === "end") {
          finish(entry, event, { by: "adapter" });
          break;
        }
        if (!entry.running) {
          entry.running = true;
          if (entry.prompts.size === 0) registry.running(entry.runId);
          pool.answered(entry.sessionId, entry.runId);
        }
        if (event.type === "denial") {
          // The provider's own denial report: the call's decision, the adapter's (#131).
          log.atomically((tx) => append(entry.sessionId, entry.runId, entry.actor, entry.calls.denied(event, tx)));
          continue;
        }
        if (event.type === "tool.ended") {
          // A call that ended ok unasked is the mode's, decided in the transaction of its end (#131).
          log.atomically((tx) => {
            entry.append(event);
            append(entry.sessionId, entry.runId, HOST_ACTOR, entry.calls.after(event, tx));
          });
          continue;
        }
        entry.append(event);
        // A call started: the host keeps its tool and summary until it is decided (#131).
        if (event.type === "tool.started") entry.calls.started(event);
      }
      if (!entry.ended) {
        finish(entry, { type: "end", reason: "error", error: { message: "The run's event stream stopped without an end.", code: "no_end" } }, { by: "host", stop: "failed" });
      }
    } catch (error) {
      if (!entry.ended) finish(entry, { type: "end", reason: "error", error: { message: messageOf(error), code: null } }, { by: "host", stop: "failed" });
    }
  };

  /** The run raised prompt `promptId`: it is parked from its first unanswered prompt, in the run registry the idle rule reads and on its process. */
  const raised = (entry: LiveRun, promptId: string): void => {
    entry.prompts.add(promptId);
    if (entry.prompts.size > 1) return;
    registry.park(entry.runId);
    pool.park(entry.sessionId, entry.runId);
  };

  /** Prompt `promptId` of the run is answered: once its last is, it runs again. */
  const answered = (entry: LiveRun, promptId: string): void => {
    if (!entry.prompts.delete(promptId) || entry.prompts.size > 0 || entry.ended) return;
    registry.resume(entry.runId);
    pool.unpark(entry.sessionId, entry.runId);
  };

  /** Denies in memory every request of the run still waiting: the run has ended, whether or not the log closed its prompts. */
  const denyWaiters = (runId: string, message: string): void => {
    for (const waiter of [...waiters.values()]) if (waiter.runId === runId) waiter.settle({ decision: "deny", message });
  };

  /**
   * The broker as a session's runs are handed it. A request is recorded as
   * `prompt.opened` on the session's stream, correlated to the session's run
   * live at the time it is made, under the prompt's id (the adapter's own
   * when it names one, else one the host mints), and parks that run. A turn
   * the provider opened on its own asks through the broker of the run it
   * followed, but only once the host has adopted it and told it its run id
   * (`onAdopted`), by which time that run is registered as the session's live
   * one: the run it parks is its own. An automatic rule (`autoAnswer`, #131)
   * answers in the same transaction, and nothing parks. Otherwise the run is
   * parked until the request is answered: by a person (`deliverAnswer`), by
   * the provider cancelling it (its signal aborts: closed `cancelled`), or
   * by the run's end, which denies it in memory. A request made when no run
   * is live, cancelled before it was made, under the id of a request the run
   * holds open, or that the log would not take, is denied at once, opens no
   * prompt and parks nothing; the answer says why (`BrokerAnswer`), for the
   * tool gate, which records such a denial of a call itself (#132).
   */
  const requestPrompt = async (sessionId: string, from: "adapter" | "gate", request: PromptRequest): Promise<BrokerAnswer> => {
    const unopened = (reason: UnopenedReason, message: string): BrokerAnswer => ({ decision: { decision: "deny", message }, unopened: reason });
    const entry = live.get(sessionId);
    if (entry === undefined || entry.ended) return unopened("run_ended", RUN_ENDED_MESSAGE);
    if (request.signal?.aborted === true) return unopened("cancelled", CANCELLED_MESSAGE);
    const promptId = request.promptId ?? randomUUID();
    // A second request under the id of one this run holds open is refused before it is recorded: the open one stands
    // and stays answerable (the prompts projection would refuse its prompt.opened anyway, as a failed record).
    if (waiters.has(waiterKey(entry.runId, promptId))) {
      console.error(`Run ${entry.runId} asked again under prompt ${promptId}, which it holds open; the second request is denied.`);
      return unopened("unrecorded", DUPLICATE_PROMPT_MESSAGE);
    }
    const stream = sessionStream(sessionId);
    const rule = autoAnswer({ kind: request.kind, attended: entry.plan.policy.attended, mode: entry.mode });
    let opened: PromptOpenedPayload;
    let ruled: ReturnType<typeof ruledAnswer> | null;
    try {
      // The TTL is fixed as it opens (#131); a prompt a rule answers at once never waits, so never expires.
      const ttlMs = rule === null ? promptTtlMs() : null;
      opened = openedPayload({
        runId: entry.runId,
        promptId,
        kind: request.kind,
        detail: request.detail,
        mode: entry.mode,
        ceiling: entry.plan.policy.mode.ceiling,
        ttlExpiresAt: ttlMs === null ? null : new Date(clock.now().getTime() + ttlMs).toISOString(),
      });
      // A rule's mode is clamped as a person's is, to the run's ceiling and its account's modes (none left: no mode is
      // given); what is recorded is what the run is handed, every part of it.
      ruled = rule === null ? null : ruledAnswer(rule.decision, opened.ceiling, entry.descriptor.modes);
      log.atomically((tx) => {
        log.append(stream, [{ type: "prompt.opened", payload: opened }], { tx, actor: entry.actor, correlationId: entry.runId });
        if (rule !== null && ruled !== null) {
          const { decision, mode } = ruled;
          const payload: PromptAnsweredPayload = {
            ...autoDenial(opened, rule.auto, decision.message ?? null),
            decision: decision.decision,
            answers: decision.answers === undefined ? null : { ...decision.answers },
            updatedInput: decision.updatedInput ?? null,
            mode,
            remember: decision.remember ?? null,
            delivery: "live",
          };
          log.append(stream, answerEvents(reader, opened, payload), { tx, actor: HOST_ACTOR, correlationId: entry.runId });
        }
      });
    } catch (error) {
      console.error(`Recording prompt ${promptId} of run ${entry.runId} failed; it is denied, and nobody was asked:`, error);
      return unopened("unrecorded", UNRECORDED_MESSAGE);
    }
    if (ruled !== null) {
      // The run continues in the mode the rule gave it, as it does after a person's answer (`deliverAnswer`).
      if (ruled.mode !== null && !entry.ended) entry.mode = ruled.mode.effective;
      return { decision: ruled.decision, unopened: null };
    }
    raised(entry, promptId);
    const answer = await new Promise<PromptDecision>((resolve) => {
      let open = true;
      const settle = (decision: PromptDecision): void => {
        if (!open) return;
        open = false;
        if (waiters.get(key) === waiter) waiters.delete(key);
        gateRequests.delete(key);
        request.signal?.removeEventListener("abort", cancel);
        answered(entry, promptId);
        resolve(decision);
      };
      // The provider cancelled it and answered it itself: the log closes it, unless someone answered first.
      const cancel = (): void => {
        if (!open) return;
        try {
          log.atomically((tx) => {
            if (parkedPromptsOfRun(reader, entry.runId).some((prompt) => prompt.promptId === promptId)) {
              log.append(stream, answerEvents(reader, opened, autoDenial(opened, "cancelled")), { tx, actor: entry.actor, correlationId: entry.runId });
            }
          });
        } catch (error) {
          console.error(`Recording the cancelling of prompt ${promptId} of run ${entry.runId} failed:`, error);
        }
        settle({ decision: "deny", message: CANCELLED_MESSAGE });
      };
      const key = waiterKey(entry.runId, promptId);
      const waiter = { runId: entry.runId, settle };
      waiters.set(key, waiter);
      if (from === "gate") gateRequests.add(key);
      request.signal?.addEventListener("abort", cancel, { once: true });
    });
    return { decision: answer, unopened: null };
  };

  /** The broker as a session's adapter is handed it: the answer alone. */
  const brokerFor = (sessionId: string): PermissionBroker => ({ request: async (request) => (await requestPrompt(sessionId, "adapter", request)).decision });

  /** A live run as the tool gate rules under it. */
  const gatedRun = (entry: LiveRun): GatedRun => ({ runId: entry.runId, sessionId: entry.sessionId, workspace: entry.plan.workspace.path, containment: entry.containment });
  /**
   * The gate a run is handed (`permissions/gate.ts`): containment's rule, then
   * the environment's (the denylist's, #132), under the session's run live
   * when it is asked. A rule asks a person through the broker, as a prompt of
   * that run's, whose answer the host hands to the gate alone; the gate is
   * told when no prompt opened, since it then records the call's decision.
   */
  const gateFor = createToolGate({
    log,
    rules: gateRules,
    ask: (run, kind, detail, signal) =>
      requestPrompt(run.sessionId, "gate", { sessionId: run.sessionId, runId: run.runId, kind, detail, ...(signal !== undefined && { signal }) }),
    liveRunOf: (sessionId) => {
      const current = live.get(sessionId);
      return current !== undefined && !current.ended ? gatedRun(current) : undefined;
    },
  });

  const contextFor = (entry: LiveRun): RunContext => ({
    broker: brokerFor(entry.sessionId),
    gate: gateFor(gatedRun(entry)),
    process: pool.port(entry.sessionId),
    adopt: (turn) => adopt(entry, turn),
    // Checked against the account store's identity for the run's account (#134). The check appends and may run as the
    // environment closes: a throw is logged, never handed back to the adapter or left an unhandled rejection.
    reportIdentity: (identity) =>
      safely(
        () => accounts.crossCheck(entry.plan.account.id, identity, entry.runId),
        (error) => console.error(`Cross-checking the identity run ${entry.runId} reported failed:`, error),
      ),
    recheckAccount: () =>
      safely(
        () => accounts.recheck(entry.plan.account.id),
        (error) => console.error(`Reading the status of the account of run ${entry.runId} again failed:`, error),
      ),
  });

  /**
   * Registers a run and starts consuming it; the run's own events are
   * appended by then. `create` is everything that can fail on the way to the
   * live run (the seams, the adapter's `createRun`): a throw ends the run
   * `error`, one microtask on, so that when the run was launched after a
   * command's commit its end is heard after the command's own events.
   */
  const begin = (plan: PlannedRun, create: (entry: LiveRun) => AdapterRun, launchedWith: readonly PromptMessage[] = []): void => {
    const { descriptor } = plan.account;
    const actor = formatActor({ kind: "adapter", id: descriptor.provider });
    const entry: LiveRun = {
      runId: plan.runId,
      sessionId: plan.sessionId,
      descriptor,
      plan,
      actor,
      append: createScopedAppend({ log, sessionId: plan.sessionId, runId: plan.runId, actor }),
      startedAt: clock.now().getTime(),
      mode: plan.mode,
      containment: runContainment(plan.policy.containment, plan.workspace.path, directories.of(plan.sessionId)),
      run: undefined,
      ended: false,
      unrecorded: false,
      running: false,
      interrupting: false,
      interruption: null,
      readNow: null,
      prompts: new Set(),
      received: false,
      launchedWith,
      calls: runToolCalls(reader, plan.runId),
    };
    // Admitted first: a drain that refuses it leaves no live entry behind.
    registry.start(plan.runId);
    live.set(plan.sessionId, entry);
    pool.begin(plan.sessionId, descriptor.provider, plan.runId);
    try {
      entry.run = create(entry);
      entry.received = true;
    } catch (error) {
      queueMicrotask(() => finish(entry, { type: "end", reason: "error", error: { message: messageOf(error), code: null } }, { by: "host", stop: "failed" }));
      return;
    }
    void consume(entry, entry.run);
  };

  /** The adapter that serves an account's runs. */
  const adapterOf = (account: AccountFacts): Adapter => {
    const adapter = adapters.get(account.descriptor.provider);
    if (adapter === undefined) throw new Error(`No adapter serves the provider ${account.descriptor.provider} of the account ${account.id}.`);
    return adapter;
  };

  /**
   * The answers kept for the run as its first messages: given to prompts
   * whose run had gone (a restart, a stop), taken by this run's start
   * (`prompts-store.ts`), each told as a message of its own, in the order
   * they were given (ADR 0007).
   */
  const keptAnswers = (runId: string): PromptMessage[] => {
    try {
      return answersFor(reader, runId).flatMap((kept) =>
        kept.answer === null ? [] : [{ messageId: randomUUID(), text: nextRunText(kept.prompt, kept.answer), attachments: [] }],
      );
    } catch (error) {
      console.error(`Reading the answers kept for run ${runId} failed; it starts without them:`, error);
      return [];
    }
  };

  const launch = (plan: PlannedRun): void => {
    const prompt: PromptMessage[] = [
      ...keptAnswers(plan.runId),
      ...plan.prompt.map((message) => {
        const held = heldAttachments.get(message.messageId);
        return held === undefined || message.attachments.length > 0 ? message : { ...message, attachments: held.attachments };
      }),
    ];
    const scope = { sessionId: plan.sessionId, accountId: plan.account.id, workspace: plan.workspace };
    begin(plan, (entry) => {
      // At a workspace level the directories it may write in are there before the provider is.
      if (entry.containment.level !== "off") directories.make(plan.sessionId);
      const run = adapterOf(plan.account).createRun(
        {
          sessionId: plan.sessionId,
          runId: plan.runId,
          account: { id: plan.account.id, directory: plan.account.directory, ...(plan.account.label !== undefined && { label: plan.account.label }) },
          workspace: plan.workspace,
          repositoryIdentity: plan.repositoryIdentity,
          model: plan.model,
          effort: plan.effort,
          mode: plan.mode,
          ceiling: plan.policy.mode.ceiling,
          // The composed instructions, then what the run appends after them (a completions request's, #138), never in their place.
          instructions: [instructions(scope), plan.appendedInstructions].filter((part): part is string => part !== null && part.trim() !== "").join("\n\n"),
          target: plan.target,
          toolServers: toolServers({ ...scope, runId: plan.runId, clientTools: plan.clientTools }),
          trusted: false,
          containment: entry.containment,
          denylist: runDenylist(plan.policy.attended),
          prompt,
        },
        contextFor(entry),
      );
      // The adapter has them: nothing need keep their bytes now. Had it thrown, the host would hold them again (`requeueUnread`).
      for (const message of prompt) unstage(message.messageId);
      return run;
    }, prompt);
  };

  /**
   * What the session's next run is started from when the environment starts
   * it itself (`continueSession`, #131): the run before it, as this host
   * last ended it, else as the log records it (after a restart), for the
   * actor its policy names, under the ceiling it was resolved under (the
   * client session behind it is not in the log, so a ceiling lowered since
   * is not read), in its model with the model's own effort. Null when the
   * session has never run.
   */
  const basisOf = (sessionId: string): NextRunBasis | null => {
    const held = lastPlans.get(sessionId);
    if (held !== undefined) return held;
    const run = latestRun(reader, sessionId);
    const policy = run === null ? null : readRunPolicy(reader, run.runId);
    if (run === null || policy === null) return null;
    return { sessionId, actor: actorOfPolicy(policy), model: run.model, effort: null, appendedInstructions: null, clientTools: [] };
  };

  /** `actor` with its client session's ceiling as it is now; undefined once that client session is revoked or expired. */
  const currentActor = (actor: RunActor): RunActor | undefined => {
    if (actor.clientSessionId === null) return actor;
    const ceiling = options.ceilingOf(actor.clientSessionId);
    return ceiling === undefined ? undefined : { ...actor, ceiling };
  };

  /**
   * Registers a turn the provider opened on its own as a run of the same
   * session (the adoption hook): `run.started` with origin `provider`, its
   * policy, the queued messages it opened with delivered, then its events
   * like any run's. The account and model are those of the run it followed;
   * the policy is resolved again (#129), as a run of the queue's is: the
   * session's mode as it is now, under the lowest of the actor's ceiling as
   * it is now and the ceiling of each message's sender. When that is not the
   * mode the provider runs the turn in, the turn is changed to it
   * (`modeChange`), and adopted only once the change has taken: a change
   * that answers later holds the adoption until it does. A turn that cannot
   * be run so (the adapter cannot change its mode, or the change fails, the
   * actor's client session is revoked or expired, no mode is available), or
   * whose session was deleted, or that a drain refuses, is let go and what it
   * was to read goes back to the environment's queue (`requeueTurn`); for
   * the first kind, a run of the queue is tried then. Nothing records a mode
   * the turn does not run in.
   */
  const adoptNow = (followed: LiveRun, turn: ProviderTurn): void => {
    const previous = followed.plan;
    /** The turn is not run, and no run starts for it: it is disposed, and what it was to read comes back to the environment's queue for the next start. */
    const letGo = (why: string, stop: ProcessStopReason = "failed"): void => letTurnGo(previous, turn, why, stop);
    let session: ReturnType<typeof readSessionFacts>;
    try {
      session = readSessionFacts(log, reader, previous.sessionId);
    } catch (error) {
      console.error(`Reading session ${previous.sessionId} to adopt a turn failed:`, error);
      letGo("whose session could not be read");
      return;
    }
    if (session === null || session.deleted) {
      // Deleted (or purged) since the run it followed: no run of it may start.
      letGo("of a deleted session", "deleted");
      return;
    }
    try {
      registry.admit();
    } catch {
      letGo("the drain refused", "drain");
      return;
    }
    /** The turn cannot run under the policy as it resolves now: it is let go, and a run of the queue reads its messages under that policy. */
    const refuse = (why: string): void => {
      console.error(`A turn the provider opened for session ${previous.sessionId} was let go: ${why}`);
      letGo("the policy refused");
      startFromQueue(previous);
    };
    const actor = currentActor(previous.actor);
    if (actor === undefined) return refuse("the client session its run was started for has been revoked or has expired.");
    const { descriptor } = previous.account;
    const ceiling = [actor.ceiling, ...messageCeilings(reader, turn.messageIds)].reduce(lowerMode);
    const policy = resolvePolicy({ actor: { ...actor, ceiling }, requested: session.mode, accountModes: descriptor.modes, containment: session.containment });
    if ("refused" in policy) return refuse(policy.refused);
    // The provider process runs the turn in the sandbox the run it followed started it with, which no adapter changes on a live process.
    const followedContainment = previous.policy.containment;
    if (policy.containment.effective !== followedContainment.effective || policy.containment.mechanism !== followedContainment.mechanism) {
      const levelOf = (containment: { effective: string; mechanism: string | null }): string =>
        containment.mechanism === null ? containment.effective : `${containment.effective} (${containment.mechanism})`;
      return refuse(
        `it runs at containment ${levelOf(followedContainment)} and the policy now resolves ${levelOf(policy.containment)}, which its process cannot take on, so a run from the queue reads its messages at the new level.`,
      );
    }
    const mode = policy.mode.effective;
    const adoptIn = (running: Mode): void => adoptTurn(previous, turn, actor, policy, running);
    if (mode !== followed.mode) {
      const setMode = turn.setMode;
      if (!descriptor.modeChange || setMode === undefined) {
        return refuse(`it runs in ${followed.mode}, the policy now resolves ${mode}, and the adapter cannot change a running turn's mode.`);
      }
      let answer: unknown;
      try {
        answer = setMode.call(turn, mode);
      } catch (error) {
        return refuse(`changing its mode from ${followed.mode} to ${mode} failed: ${messageOf(error)}`);
      }
      if (answer instanceof Promise) {
        changingMode.set(previous.sessionId, { runId: followed.runId, descriptor, policy: previous.policy });
        // Runs once the change has answered, in a promise callback: nothing it does may throw out of it, or the rejection would be nobody's.
        const settled = (work: () => void): void => {
          changingMode.delete(previous.sessionId);
          let admitted: boolean;
          try {
            const now = readSessionFacts(log, reader, previous.sessionId);
            admitted = !closing && now !== null && !now.deleted;
            if (admitted) registry.admit();
          } catch (error) {
            // The session could not be read, or the drain refused: the turn is let go either way.
            if (!closing) console.error(`Reading session ${previous.sessionId} after its turn's mode change failed:`, error);
            admitted = false;
          }
          if (!admitted) {
            // Closing, deleted or draining since: the turn is let go, and what it was to read goes back.
            letGo("whose mode changed too late");
            return;
          }
          work();
        };
        answer.then(
          () => safely(() => settled(() => adoptIn(mode)), (e) => console.error("Adopting a turn after its mode change failed:", e)),
          (error: unknown) =>
            safely(
              () => settled(() => refuse(`changing its mode from ${followed.mode} to ${mode} failed: ${messageOf(error)}`)),
              (e) => console.error("Letting a turn go after its mode change failed:", e),
            ),
        );
        return;
      }
    }
    adoptIn(mode);
  };

  /**
   * Records and starts the adopted turn in `mode`, the mode it runs in now.
   * A throw on the way (a drain that refuses it, an append that fails) lets
   * the turn go, its messages the environment's again.
   */
  const adoptTurn = (previous: PlannedRun, turn: ProviderTurn, actor: RunActor, policy: RunPolicy, mode: Mode): void => {
    const runId = randomUUID();
    const { descriptor } = previous.account;
    const plan: PlannedRun = { ...previous, runId, prompt: [], target: { kind: "fresh" }, mode, actor, policy };
    const started: RunStartedPayload = {
      runId,
      accountId: plan.account.id,
      identity: accounts.facts(plan.account.id)?.identity ?? null,
      model: plan.model,
      effort: plan.effort,
      mode: { requested: policy.mode.requested, effective: mode, clamped: policy.mode.clamped },
      workspace: plan.workspace,
      origin: "provider",
      promptMessageId: null,
      queuedMessageIds: [...turn.messageIds],
      resumedFrom: null,
      forkedFrom: null,
    };
    const delivered = turn.messageIds.map((messageId): EventInput => {
      const payload: MessageDeliveredPayload = { runId, messageId, delivery: "prompt" };
      return { type: "message.delivered", payload };
    });
    try {
      const events: EventInput[] = [{ type: "run.started", payload: started }, policyResolvedEvent(runId, policy), ...delivered];
      const attribution = { actor: formatActor({ kind: "adapter", id: descriptor.provider }), correlationId: runId };
      log.atomically((tx) => appendRunEvents(log, plan.sessionId, events, { ...attribution, tx }));
    } catch (error) {
      console.error(`Recording a turn the provider opened for session ${previous.sessionId} failed; it is let go:`, error);
      letTurnGo(previous, turn, "whose start could not be recorded", "failed");
      return;
    }
    // The provider read them, bytes and all.
    for (const messageId of turn.messageIds) unstage(messageId);
    begin(plan, () => {
      // Told its run id once the run is registered (live, in the run registry, on its process) and before its events are
      // read, so a prompt it asks at once parks it; a turn let go before this is never told one.
      safely(() => turn.onAdopted?.(runId), (e) => console.error("Telling an adopted turn its run id failed:", e));
      return turn;
    });
  };

  /** A provider-opened turn the host will not run: the messages it opened with, still the provider's, are the environment's again. */
  const requeueTurn = (previous: PlannedRun, turn: ProviderTurn): void => {
    try {
      requeue(previous.sessionId, previous.runId, turn.messageIds);
    } catch (error) {
      console.error(`Taking back the messages of a turn of session ${previous.sessionId} failed:`, error);
    }
  };

  /**
   * Lets go of a turn the provider opened that no run will carry: it is
   * disposed, what it was to read comes back to the environment's queue, and,
   * since a dispose leaves the provider's state unknown, the session's
   * process is stopped through the pool for `stop`'s reason, as for a run
   * the host ends itself; not while another run is live on it.
   */
  const letTurnGo = (previous: PlannedRun, turn: ProviderTurn, why: string, stop: ProcessStopReason): void => {
    safely(() => turn.dispose(), (e) => console.error(`Disposing a turn ${why} failed:`, e));
    requeueTurn(previous, turn);
    const current = live.get(previous.sessionId);
    if (current === undefined || current.ended) void pool.stop(previous.sessionId, stop);
  };

  /** Lets go of every turn waiting to be adopted into the session, its messages taken back. */
  const dropAdoptions = (sessionId: string): void => {
    for (const { followed, turn } of adoptions.get(sessionId) ?? []) {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn failed:", e));
      requeueTurn(followed.plan, turn);
    }
    adoptions.delete(sessionId);
  };

  const adopt = (followed: LiveRun, turn: ProviderTurn): void => {
    const previous = followed.plan;
    if (closing) {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn adopted while closing failed:", e));
      requeueTurn(previous, turn);
      return;
    }
    const current = live.get(previous.sessionId);
    if (current !== undefined && isLive(current)) {
      adoptions.set(previous.sessionId, [...(adoptions.get(previous.sessionId) ?? []), { followed, turn }]);
      return;
    }
    adoptNow(followed, turn);
  };

  /**
   * After a run completed or failed, starts the next with the messages the
   * environment holds for the session, if any (ADR 0022: an adapter without
   * a provider queue reads its queue when the turn ends), for the actor of
   * the run before it under its ceiling as it is now, and each queued
   * sender's (the decider takes the lowest), in the session's mode as it is
   * now: the run before it may have named a mode of its own, which was that
   * run's alone (#129). Not while the environment drains, nor once that
   * actor's client session is revoked or expired: the messages stay queued
   * for the next start.
   *
   * With `forAnswers`, it starts one too when nothing is queued but an
   * answer is kept for the session's next run and no run has taken it (#131:
   * a TTL answer whose run had gone), so the session continues on its own:
   * the run reads the answer first, then whatever is queued.
   */
  const startFromQueue = (previous: NextRunBasis, forAnswers = false): void => {
    try {
      const queued = queuedFor(previous.sessionId).length > 0;
      if (!queued && !(forAnswers && hasKeptAnswer(reader, previous.sessionId))) return;
      registry.admit();
      const actor = currentActor(previous.actor);
      if (actor === undefined) {
        console.error(`The queued messages of session ${previous.sessionId} wait: the client session they would run for has been revoked or has expired.`);
        return;
      }
      const facts = startFacts(previous.sessionId, actor);
      const decision = decideStart(facts, {
        // The run is the actor's: a completions request's queue runs as completions, a routine's as routine (#138).
        origin: originOfActor(actor),
        message: null,
        model: previous.model,
        ...(previous.effort !== null && { effort: previous.effort }),
        ...(forAnswers && { keptAnswers: true }),
        ...(previous.appendedInstructions !== null && { appendedInstructions: previous.appendedInstructions }),
        clientTools: previous.clientTools,
      });
      if (decision.rejected !== undefined) {
        console.error(`The queued messages of session ${previous.sessionId} could not start a run: ${decision.rejected.message}`);
        return;
      }
      log.atomically((tx) =>
        appendRunEvents(log, previous.sessionId, decision.events, { tx, actor: HOST_ACTOR, correlationId: decision.run.runId }),
      );
      launch(decision.run);
    } catch (error) {
      console.error(`Starting the next run of session ${previous.sessionId} from its queue failed:`, error);
    }
  };

  /**
   * A steered message's bytes are read (a run of the queue takes its own at
   * launch); a purged session's are dropped; a deleted session's live run is
   * let go, and its waiting turns with it. The bytes wait for the purge, not
   * the deletion, since a restore brings the session back with its queue.
   */
  const unsubscribe = log.subscribe((event) => {
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    if (event.type === "session.title-set") {
      const { title } = event.payload as SessionTitleSetPayload;
      if (title !== null) mirrorTitle(event.streamId, title);
      return;
    }
    if (event.type === "message.delivered") {
      const delivered = event.payload as MessageDeliveredPayload;
      if (delivered.delivery === "steered") unstage(delivered.messageId);
      return;
    }
    // Withdrawn (#228): no run will read its bytes, which go as a read message's do.
    if (event.type === "message.withdrawn") {
      unstage((event.payload as MessageWithdrawnPayload).messageId);
      return;
    }
    if (event.type === "session.purged") {
      for (const [messageId, staged] of [...heldAttachments]) if (staged.sessionId === event.streamId) unstage(messageId);
      lastPlans.delete(event.streamId);
      return;
    }
    if (event.type === "session.rewound") {
      // The kept process holds the conversation the rewind cut: the next run starts cold from the rewind's point (#137).
      void pool.stop(event.streamId, "rewound");
      return;
    }
    if (event.type !== "session.deleted") return;
    dropAdoptions(event.streamId);
    const entry = live.get(event.streamId);
    if (entry !== undefined) finish(entry, { type: "end", reason: "disposed" }, { by: "host", stop: "deleted" });
    void pool.stop(event.streamId, "deleted");
  });

  /**
   * The adapter that holds a session's provider transcript: its latest run's
   * account's, else the default account's. When neither names an account on
   * this environment the session's provider is unknown, and what asked is
   * refused `unsupported` (the purge records it so: `sessions/deletion.ts`
   * reads the refusal's reason).
   */
  const adapterOfSession = (sessionId: string, flag: AdapterCapabilityFlag, what: string): Adapter => {
    const adapter = adapterOfAccount(latestRun(reader, sessionId)?.accountId ?? accounts.defaultId());
    if (adapter === undefined) {
      throw new ContractError({
        code: "invalid_params",
        message: `The provider of session ${sessionId} is not known here, so ${what}.`,
        data: { reason: "unsupported", capability: flag },
      });
    }
    return adapter;
  };

  /** The accounts the session's runs went through, as the environment still holds them: where its provider may have left a transcript. */
  const accountsOfSession = (sessionId: string): (AccountRef & { readonly adopted: boolean })[] =>
    reader.all<{ account_id: string }>("SELECT DISTINCT account_id FROM runs WHERE session_id = ? ORDER BY account_id", sessionId).flatMap((row) => {
      const facts = accounts.facts(row.account_id);
      return facts === null ? [] : [{ id: facts.id, directory: facts.directory, adopted: facts.adopted }];
    });

  /**
   * The purge's transcript delete (#118), handed only the owned accounts the
   * session ran under: an adopted directory is read and written only by the
   * provider's own CLI (ADR 0018, user story 5), so a copy there is kept and
   * the answer says so, whatever the adapter deleted elsewhere (#137).
   */
  const transcripts: ProviderTranscripts = adapters.list().some((adapter) => adapter.descriptor.transcriptDelete)
    ? {
        deleteTranscript: (sessionId) => {
          const adapter = adapterOfSession(sessionId, "transcriptDelete", "its transcript cannot be deleted");
          const remove = capability(adapter.descriptor, "transcriptDelete", adapter.deleteTranscript, "delete a provider transcript", "deleteTranscript");
          // Only the accounts of this adapter's provider: another provider's CLI keeps its files its own way.
          const ran = accountsOfSession(sessionId).filter((account) => accounts.providerOf(account.id) === adapter.descriptor.provider);
          const owned = ran.filter((account) => !account.adopted).map(({ id, directory }) => ({ id, directory }));
          const adopted = owned.length < ran.length;
          // Nothing to hand over when every account it ran under is adopted; a session that never ran is the adapter's to answer.
          const answered: unknown = adopted && owned.length === 0 ? undefined : remove.call(adapter, sessionId, owned);
          // An answer that is not synchronous is the purge's to refuse (`sessions/deletion.ts`), so it is passed on as it is.
          if (answered !== undefined) return answered as TranscriptDeleteAnswer;
          return adopted ? { kept: "adopted-directory" } : undefined;
        },
      }
    : {};

  const subagentTranscript = async (sessionId: string, agentId: string): Promise<readonly JsonObject[]> => {
    const adapter = adapterOfSession(sessionId, "subagentTranscripts", "its subagents' transcripts cannot be read");
    const read = capability(adapter.descriptor, "subagentTranscripts", adapter.subagentTranscript, "read a subagent's transcript", "subagentTranscript");
    return read.call(adapter, sessionId, agentId);
  };

  /**
   * `sessions.create`'s check against the account store (#134): an account
   * named that the environment does not hold, or that is not signed in,
   * cannot run, and is refused `account_unavailable` as `runs.start` refuses
   * it; a session that names none takes the default at each run. The model
   * is checked against that account's catalogue (the default's, when it
   * names none), and the mode against its adapter's.
   */
  const validateSessionInput: RunParametersCheck = (parameters: RunParameters): RunParametersVerdict => {
    const issues: IssueInput[] = [];
    if (parameters.account !== null) {
      const named = accounts.facts(parameters.account);
      if (named === null || !named.signedIn) {
        const why = named === null ? "is not on this environment" : "is not signed in on this environment";
        return { unavailable: { accountId: parameters.account, message: `The account ${parameters.account} ${why}, so no run can start on it.` } };
      }
    }
    const facts = account(parameters.account);
    if (parameters.model !== null) {
      if (facts === null) issues.push({ code: "custom", path: ["model"], message: `No account on this environment offers the model ${parameters.model}.` });
      else if (!facts.models.some((model) => model.id === parameters.model)) {
        issues.push({ code: "custom", path: ["model"], message: `The account ${facts.id} does not offer the model ${parameters.model}.` });
      }
    }
    if (parameters.mode !== null) {
      if (facts === null) issues.push({ code: "custom", path: ["mode"], message: `No account on this environment has the mode ${parameters.mode}.` });
      else if (!facts.descriptor.modes.some((entry) => entry.mode === parameters.mode)) {
        issues.push({ code: "custom", path: ["mode"], message: `The ${facts.descriptor.displayName} adapter has no mode ${parameters.mode}.` });
      }
    }
    return { issues };
  };

  /**
   * Hands an answer to the live run's adapter when it takes answers
   * (`interactivePrompts`), for `deliverAnswer`, which settles the broker's
   * request whatever this says: the refusals are the caller's `conflict`,
   * any other failure `internal`, at once or asynchronously.
   */
  const answerThroughAdapter = (entry: LiveRun, promptId: string, decision: PromptDecision): void | Promise<void> => {
    const { runId, run } = entry;
    if (!entry.descriptor.interactivePrompts || run?.answerPrompt === undefined) return undefined;
    const closed = (reason: "run_ended" | "prompt_not_open", message: string): ContractError =>
      new ContractError({ code: "conflict", message, data: { reason, runId, promptId } });
    // The host's own record first, whatever the adapter would say: a prompt this live run has not raised, or that is
    // answered already, is not open.
    if (!entry.prompts.has(promptId)) throw closed("prompt_not_open", `Run ${runId} has no prompt ${promptId} open.`);
    // Answered either way: a prompt the adapter no longer holds open parks nothing.
    answered(entry, promptId);
    // One contract, at once or asynchronously: a closed prompt is the caller's `conflict`; any other failure is logged
    // and refused `internal`, so the caller knows the answer did not land.
    const refusal = (error: unknown): ContractError => {
      if (error instanceof PromptClosed) return closed(error.reason === "run_ended" ? "run_ended" : "prompt_not_open", error.message);
      console.error(`Answering prompt ${promptId} of run ${runId} failed:`, error);
      return new ContractError({ code: "internal", message: `Answering prompt ${promptId} failed: ${messageOf(error)}`, data: {} });
    };
    let answering: void | Promise<void>;
    try {
      answering = run.answerPrompt(promptId, decision);
    } catch (error) {
      throw refusal(error);
    }
    // An adapter that answers asynchronously refuses through the promise, which the caller is handed with the same mapping.
    if (answering instanceof Promise) {
      return answering.catch((error: unknown) => {
        throw refusal(error);
      });
    }
    return undefined;
  };

  /** Asks `run`, the live run `entry` as `withdraw` found it, to take message `messageId` back (#228). */
  const withdrawThrough = async (entry: LiveRun, run: AdapterRun, messageId: string): Promise<{ readonly withdrawn: boolean }> => {
    const withdraw = capability(entry.descriptor, "providerQueue", run.withdraw, "withdraw a queued message", "withdraw");
    const interruption = entry.interruption;
    // Kept out of any run that starts before the command has decided on it (let go by `settleWithdraw`): one an end
    // starts from the queue once the message is back in it, or the run of a read-now whose interrupt took it.
    withdrawing.add(messageId);
    let answer: { readonly withdrawn: boolean };
    try {
      answer = await withdraw.call(run, messageId);
    } catch (error) {
      withdrawing.delete(messageId);
      if (error instanceof WithdrawUnsupported) {
        throw unsupported(entry.descriptor, "providerQueue", ["messageId"], "withdraw a queued message", error.message);
      }
      console.error(`Withdrawing message ${messageId} from the provider of run ${entry.runId} failed:`, error);
      throw new ContractError({ code: "internal", message: `The provider could not say whether it still held message ${messageId}: ${messageOf(error)}`, data: {} });
    }
    if (answer.withdrawn) {
      // The provider gave it up: the environment holds it now, in a transaction of its own, so nothing that fails after this loses it.
      if (!closing) requeueReported(entry.sessionId, [messageId]);
      return answer;
    }
    // Not held any more while the run's interrupt is under way: the interrupt may have taken it back. Decided again on the log once it has.
    if (interruption !== null) await interruption;
    return answer;
  };

  return {
    adapters,
    runs: registry,
    activeRuns: () => [...live.values()].filter(isLive).map(({ runId, sessionId }) => ({ runId, sessionId })),
    account,
    validateSessionInput,
    transcripts,
    subagentTranscript,
    admit: () => registry.admit(),
    startFacts,
    live: (sessionId) => liveFacts(live.get(sessionId)),
    runActive,
    liveRun: (runId) => liveFacts(byRunId(runId)),
    unrecorded: (runId) => unrecordedRuns.has(runId),
    launch,
    continueSession(sessionId) {
      if (closing || changingMode.has(sessionId)) return;
      const current = live.get(sessionId);
      if (current !== undefined && isLive(current)) return;
      let basis: NextRunBasis | null;
      try {
        const session = readSessionFacts(log, reader, sessionId);
        basis = session === null || session.deleted ? null : basisOf(sessionId);
      } catch (error) {
        console.error(`Reading session ${sessionId} to continue it failed:`, error);
        return;
      }
      if (basis !== null) startFromQueue(basis, true);
    },
    stageAttachments(message) {
      if (stage === undefined || message.attachments.length === 0) return;
      try {
        stage.write(message.messageId, message.attachments);
      } catch (error) {
        console.error(`Staging the attachments of message ${message.messageId} failed; the send is refused:`, error);
        throw new ContractError({
          code: "internal",
          message: "The message's attachments could not be kept on disk, so it was not sent; send it again.",
          data: {},
        });
      }
    },
    queue(send) {
      // Kept whoever holds it: an interrupt may hand a provider-held message back to the environment's queue.
      const sessionId = readRun(reader, send.runId)?.sessionId ?? null;
      if (sessionId !== null) heldAttachments.set(send.message.messageId, { sessionId, attachments: send.message.attachments });
      if (send.heldBy === "environment") return;
      const entry = byRunId(send.runId);
      if (entry === undefined || entry.ended) {
        // Its run ended before the send was handed on, and that end took back only what was on the log then: the
        // provider never had this one, so the environment holds it (ADR 0022: nothing is lost).
        if (!closing && sessionId !== null) requeue(sessionId, send.runId, [send.message.messageId]);
        return;
      }
      const run = entry.run;
      const handing = safely(
        () => run?.send(send.message),
        (error) => {
          // The provider did not take it, so the environment holds it: the next run reads it (ADR 0022).
          console.error(`Handing message ${send.message.messageId} to run ${send.runId} failed; the environment holds it:`, error);
          if (!closing) requeue(entry.sessionId, send.runId, [send.message.messageId]);
        },
      );
      // A refusal that comes after the run's end hands the message back after it: a rewind waits for the answer (#245).
      if (handing !== undefined) track(entry.sessionId, handing);
    },
    interrupt(runId) {
      const entry = byRunId(runId);
      if (entry === undefined || entry.ended || entry.run === undefined) return;
      // A person's interrupt after a read-now is the last word: the run ends interrupted by them, and no run of the queue starts.
      entry.readNow = null;
      if (!entry.interrupting) void interruptRun(entry);
    },
    readNow(sessionId, actor) {
      const entry = live.get(sessionId);
      if (closing || entry === undefined || entry.ended || entry.readNow !== null) return;
      const pending: ReadNow = { actor, interrupted: false, ended: false, started: false };
      entry.readNow = pending;
      // An interrupt already under way is waited on: once what it took back is queued, the run of the queue can start.
      void interruptRun(entry).then(() => {
        pending.interrupted = true;
        if (entry.readNow === pending) startReadNow(entry);
      });
    },
    withdraw(sessionId, messageId) {
      const entry = live.get(sessionId);
      // No run is live to ask: the provider's queue is read by a turn it opened, waiting to be adopted.
      if (entry === undefined || entry.ended || entry.run === undefined) return Promise.resolve({ withdrawn: false });
      const asking = withdrawThrough(entry, entry.run, messageId);
      // The provider's answer may come after the run's end and hand the message back after it: a rewind waits for it (#245).
      track(sessionId, asking);
      return asking;
    },
    settleWithdraw(messageId) {
      withdrawing.delete(messageId);
    },
    handingBack: (sessionId) => handingBack.has(sessionId),
    async handedBack(sessionId) {
      // Work begun meanwhile is waited for too, unless it is an active run's, which refuses the rewind whatever comes back.
      for (let pending = handingBack.get(sessionId); pending !== undefined && runActive(sessionId) === null; pending = handingBack.get(sessionId)) {
        await Promise.allSettled([...pending]);
      }
    },
    nextRunBasis: (sessionId) => basisOf(sessionId),
    holdsPrompt: (runId, promptId) => byRunId(runId)?.prompts.has(promptId) === true,
    deliverAnswer(runId, promptId, decision) {
      const entry = byRunId(runId);
      try {
        // A prompt the gate raised is the gate's to hear, never the adapter's: settling the request below hands it over.
        if (entry === undefined || gateRequests.has(waiterKey(runId, promptId))) return undefined;
        return answerThroughAdapter(entry, promptId, decision);
      } finally {
        // The answer is in the log: the request is settled whatever the adapter said, so nothing waits on it.
        waiters.get(waiterKey(runId, promptId))?.settle(decision);
        if (entry !== undefined && !entry.ended && decision.decision === "allow" && decision.mode !== undefined) entry.mode = decision.mode;
      }
    },
    stopTask(runId, taskId) {
      const entry = byRunId(runId);
      const run = entry?.run;
      if (entry === undefined || run === undefined) return;
      const stop = capability(entry.descriptor, "subagents", run.stopTask, "stop delegated work", "stopTask");
      safely(() => stop.call(run, taskId), (error) => console.error(`Stopping task ${taskId} of run ${runId} failed:`, error));
    },
    setMode(runId, mode) {
      const entry = byRunId(runId);
      const run = entry?.run;
      if (entry === undefined || run === undefined) return;
      const failed = (error: unknown) => console.error(`Changing the mode of run ${runId} failed; it keeps ${entry.mode} until its session's next run:`, error);
      safely(() => {
        const answer = capability(entry.descriptor, "modeChange", run.setMode, "change a live run's mode", "setMode").call(run, mode);
        if (answer instanceof Promise) return answer.then(() => void (entry.mode = mode));
        entry.mode = mode;
        return undefined;
      }, failed);
    },
    async usage(accountId) {
      const held = heldAccount(accountId);
      const read = capability(held.adapter.descriptor, "planUsage", held.adapter.usage, "read plan usage", "usage");
      return read.call(held.adapter, held.ref);
    },
    async commands(accountId, workspace) {
      const held = heldAccount(accountId);
      const list = capability(held.adapter.descriptor, "commands", held.adapter.commands, "list commands", "commands");
      return list.call(held.adapter, held.ref, workspace);
    },
    providers: () => adapters.list().map((adapter) => adapter.descriptor),
    processes: {
      list: () => pool.list(),
      running: (sessionId) => pool.running(sessionId),
      stop(sessionId, by) {
        const entry = live.get(sessionId);
        // A person stopped the process under the run: the run ends interrupted, as runs.interrupt would end it, and says who.
        if (entry !== undefined && !entry.ended) finish(entry, { type: "end", reason: "interrupted", cause: "user" }, { by: "host", stop: "admin", ...by });
        void pool.stop(sessionId, "admin");
      },
    },
    drain: () => pool.drain(),
    async close(reason) {
      if (closing) return;
      closing = true;
      unsubscribe();
      const stop: ProcessStopReason = reason === "drained" ? "drain" : "closed";
      for (const entry of [...live.values()]) finish(entry, { type: "end", reason }, { by: "host", stop });
      for (const sessionId of [...adoptions.keys()]) dropAdoptions(sessionId);
      await pool.close(stop);
      // The preset's own root, if it made one; the environment's directories stay with its data directory.
      await directories.close().catch((error: unknown) => console.error("Removing the host's containment directories failed:", error));
    },
  };
};
