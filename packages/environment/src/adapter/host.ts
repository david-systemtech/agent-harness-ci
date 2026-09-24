import { randomUUID } from "node:crypto";
import {
  ContractError,
  SESSION_STREAM_KIND,
  lowerMode,
  type AccountIdentity,
  type IssueInput,
  type MessageDeliveredPayload,
  type MessageRequeuedPayload,
  type Mode,
  type ProcessStopReason,
  type ProviderProcess,
  type RunEndedPayload,
  type RunPolicy,
  type RunStartedPayload,
  type SessionTitleSetPayload,
  type Workspace,
} from "@agent-harness/contracts";
import { formatActor, type EventEnvelope, type EventLog, type EventInput } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import { environmentQueue, latestRun, messageCeilings, providerHeld, providerSessionOf, readRun, readSessionFacts } from "../runs/run-reads.js";
import {
  decideStart,
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
import type { ProviderTranscripts } from "../sessions/deletion.js";
import type { RunParameters, RunParametersCheck } from "../sessions/run-parameters.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { recordProviderTitle } from "../sessions/titles.js";
import { capability } from "./capabilities.js";
import type {
  AccountRef,
  Adapter,
  AdapterDescriptor,
  AdapterRun,
  AttachmentData,
  PermissionBroker,
  PromptMessage,
  ProviderCommand,
  ProviderTurn,
  RunContext,
  RunEnd,
  UsageReading,
} from "./contract.js";
import { createProcessPool } from "./pool.js";
import type { PromptDecision } from "./contract.js";
import { createAdapterRegistry, type AdapterRegistry } from "./registry.js";
import { createScopedAppend, type ScopedAppend } from "./scoped-append.js";
import {
  autoDenyBroker,
  composeInstructions,
  noToolServers,
  presetPolicy,
  type InstructionComposer,
  type PolicySeam,
  type ToolServerFactory,
} from "./seams.js";

/**
 * The adapter host (claude-adapter spec, "Modules and ownership" and "The
 * adapter contract"; ADR 0015): what stands between the adapters and the
 * rest of the environment. It holds the adapter registry and the accounts'
 * sign-in states and catalogues, fills the run registry the lifecycle reads
 * for idle and drain (#112), and supplies each run with its seams (tool
 * servers, composed instructions, the broker, the policy resolver). It starts a
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
 */

/** An account the host serves runs through: its id, its provider, and its config directory. The account store (#134) will supply these. */
export interface HostAccount {
  readonly id: string;
  readonly provider: string;
  /** The account's config directory; null for the provider's own default. */
  readonly directory?: string | null;
}

export interface AdapterHostOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The run registry the lifecycle reads; preset: a fresh one on `clock`. */
  readonly runs?: MemoryRunRegistry;
  readonly adapters?: readonly Adapter[];
  readonly accounts?: readonly HostAccount[];
  /** The account a session with none of its own runs on; preset: the first account. */
  readonly defaultAccountId?: string;
  readonly toolServers?: ToolServerFactory;
  readonly instructions?: InstructionComposer;
  readonly broker?: PermissionBroker;
  /** The policy resolver runs start through; preset: the resolver on the settings' presets. */
  readonly resolvePolicy?: PolicySeam;
  /**
   * A client session's ceiling as it is now, which a run the environment
   * starts after another (from its queue, or a turn the provider opened) is
   * resolved under, so a ceiling changed since applies; undefined once the
   * client session is revoked or expired, and such a run is not started.
   */
  readonly ceilingOf: (clientSessionId: string) => Mode | undefined;
  /** How long an account's status or model probe may take before it counts as failed, so a hung probe cannot hang startup. Preset: `PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
  /**
   * The idle time of a provider process, in minutes (`providers.processIdleMinutes`),
   * read each time a wait begins. Preset: the setting's preset; the
   * environment passes the settings store's value.
   */
  readonly processIdleMinutes?: () => number;
  /** How long closing waits, on the clock, for the provider processes to stop before it kills the rest. Preset: `PROCESS_STOP_TIMEOUT_MS`. */
  readonly processStopTimeoutMs?: number;
  /** Where the bytes of sent messages' attachments wait until a run reads them, by message id. Preset: a fresh in-memory map, lost on a restart; staging them durably is #185's. */
  readonly stagedAttachments?: Map<string, StagedAttachments>;
}

/** The attachments of one message waiting to be read, with the session it was sent to. Never logged. */
export interface StagedAttachments {
  readonly sessionId: string;
  readonly attachments: readonly AttachmentData[];
}

/** How long an account's status or model probe may take before the host gives up on it. */
export const PROBE_TIMEOUT_MS = 5_000;

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
  /** Reads every account's sign-in state and catalogue through its adapter's probe; startup runs it once. */
  refresh(): Promise<void>;
  /** The account `id` names, or the default account for null; null when it is not on this environment. */
  account(id: string | null): AccountFacts | null;
  /** The check `sessions.create` delegates its account, model and mode to. */
  readonly validateSessionInput: RunParametersCheck;
  /** The transcript delete a purge calls (#118), routed to the session's adapter; absent when no adapter declares it. */
  readonly transcripts: ProviderTranscripts;
  /** Throws `unavailable` while the environment drains: the gate every new run passes. */
  admit(): void;
  /** What starting a run on the session for `actor` depends on, read now (inside a command, in its transaction). */
  startFacts(sessionId: string, actor: RunActor): StartFacts;
  /** The session's live run and its adapter's descriptor; null when none is live. */
  live(sessionId: string): LiveRunFacts | null;
  /** The live run `runId` names; null once it has ended. */
  liveRun(runId: string): LiveRunFacts | null;
  /** Whether the run ended here with its `run.ended` not in the log (two appends failed): the recovery sweep (#120) records it at the next start. */
  unrecorded(runId: string): boolean;
  /** Starts a run its command committed: through its adapter, its events consumed from here on. */
  launch(run: PlannedRun): void;
  /** Hands a message sent during a live run to its provider, or holds it for the next run, once its event committed. */
  queue(send: QueuedSend): void;
  /** Interrupts a live run with cancel; the messages its provider still held come back to the environment's queue. */
  interrupt(runId: string): void;
  /** Stops a piece of a live run's delegated work. */
  stopTask(runId: string, taskId: string): void;
  /** Changes a live run's mode through its adapter (`modeChange`), once the command that asked has committed; its resolved policy stays. */
  setMode(runId: string, mode: Mode): void;
  /**
   * Answers a prompt the run raised through the broker: handed to its
   * adapter (`interactivePrompts`), and the run no longer parked on it. The
   * way every answer a client gives reaches a run (#130).
   */
  answerPrompt(runId: string, promptId: string, decision: PromptDecision): void;
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
 * Who ends a run: its adapter, whose end event is recorded; or the host,
 * which disposes the run and stops its process for `stop`'s reason, and
 * records the end as its own, or as `actor`'s under `commandId` when a
 * person's command ended it.
 */
type EndedBy =
  | { readonly by: "adapter" }
  | { readonly by: "host"; readonly stop: ProcessStopReason; readonly actor?: string; readonly commandId?: string };

/** An account as the host holds it once its probe has answered. */
interface HeldAccount {
  readonly config: HostAccount;
  readonly adapter: Adapter;
  facts: AccountFacts;
}

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
  /** The prompts it raised that are not answered yet, by id: while any is, the run is parked. */
  readonly prompts: Set<string>;
  /** Whether its adapter was handed the run's input; until then the messages it was launched with are still the environment's. */
  received: boolean;
  /** The messages the run was launched with, bytes included. */
  readonly launchedWith: readonly PromptMessage[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Settles as `work` does, or rejects once `ms` have passed on the wall clock (never the environment's, which a test may hold still). */
const withTimeout = <T>(work: () => Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${ms} ms.`)), ms);
    timer.unref();
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });

/** Runs `work` and hands a promise it answers, or a throw, to `onError`; never an unhandled rejection. */
const safely = (work: () => unknown, onError: (error: unknown) => void): void => {
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
    if (answer instanceof Promise) answer.catch(handle);
  } catch (error) {
    handle(error);
  }
};

export const createAdapterHost = (options: AdapterHostOptions): AdapterHost => {
  const { log, clock } = options;
  const adapters = createAdapterRegistry(options.adapters ?? []);
  const registry = options.runs ?? createRunRegistry({ clock });
  const toolServers = options.toolServers ?? noToolServers;
  const instructions = options.instructions ?? composeInstructions();
  const broker = options.broker ?? autoDenyBroker;
  const resolvePolicy = options.resolvePolicy ?? presetPolicy;
  const configs = options.accounts ?? [];
  const defaultAccountId = options.defaultAccountId ?? configs[0]?.id ?? null;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const accounts = new Map<string, HeldAccount>();
  /** Live runs by session: at most one each. */
  const live = new Map<string, LiveRun>();
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
   * never logged, and not kept across a restart: the `run_messages` rows
   * keep a queued message's text, which is all a message the recovery sweep
   * hands back is read by, and its bytes are #185's to keep.
   */
  const heldAttachments = options.stagedAttachments ?? new Map<string, StagedAttachments>();
  let closing = false;

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

  const refOf = (account: HostAccount): AccountRef => ({ id: account.id, directory: account.directory ?? null });

  // An account is known from the start, signed out until its probe says otherwise.
  for (const config of configs) {
    const adapter = adapters.get(config.provider);
    if (adapter === undefined) {
      console.error(`The account ${config.id} names the provider ${config.provider}, which no adapter serves; it is left out.`);
      continue;
    }
    accounts.set(config.id, {
      config,
      adapter,
      facts: { id: config.id, directory: config.directory ?? null, signedIn: false, identity: null, descriptor: adapter.descriptor, models: [] },
    });
  }

  const probe = async (held: HeldAccount): Promise<void> => {
    const ref = refOf(held.config);
    const { provider } = held.adapter.descriptor;
    let signedIn = false;
    let identity: AccountIdentity | null = null;
    try {
      const status = await withTimeout(() => held.adapter.status(ref), probeTimeoutMs, `The status probe of the account ${held.config.id}`);
      signedIn = status.signedIn;
      if (status.signedIn && status.email !== null) identity = { provider, email: status.email, organisation: status.orgName };
    } catch (error) {
      console.error(`Reading the status of the account ${held.config.id} failed:`, error);
    }
    let models = held.facts.models;
    try {
      models = (await withTimeout(() => held.adapter.models(ref), probeTimeoutMs, `The model listing of the account ${held.config.id}`)).models;
    } catch (error) {
      console.error(`Reading the models of the account ${held.config.id} failed:`, error);
    }
    held.facts = { ...held.facts, signedIn, identity, models };
  };

  const heldAccount = (id: string): HeldAccount => {
    const held = accounts.get(id);
    if (held === undefined) throw new Error(`No account ${id} is on this environment.`);
    return held;
  };

  const account = (id: string | null): AccountFacts | null => {
    const which = id ?? defaultAccountId;
    return which === null ? null : (accounts.get(which)?.facts ?? null);
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
      }
    }
    append(entry.sessionId, entry.runId, HOST_ACTOR, requeuedEvents(entry.runId, read));
  };

  /** Takes back into the environment's queue the messages of `runId` that the provider still holds, of `messageIds` or all. */
  const requeue = (sessionId: string, runId: string, messageIds?: readonly string[]): void => {
    const held = providerHeld(reader, sessionId, runId).filter((messageId) => messageIds === undefined || messageIds.includes(messageId));
    append(sessionId, runId, HOST_ACTOR, requeuedEvents(runId, held));
  };

  const startFacts = (sessionId: string, actor: RunActor): StartFacts => {
    const session = readSessionFacts(log, reader, sessionId);
    const accountId = session?.account ?? defaultAccountId;
    const facts = account(accountId);
    return {
      sessionId,
      session,
      live: liveFacts(live.get(sessionId)) ?? changingMode.get(sessionId) ?? null,
      accountId,
      account: facts,
      queued: environmentQueue(reader, sessionId),
      resumeFrom: facts?.descriptor.resume === true ? providerSessionOf(reader, sessionId) : null,
      actor,
      resolvePolicy,
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
    const adapter = accountId === undefined ? undefined : accounts.get(accountId)?.adapter;
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
      cause: reason === "interrupted" ? (entry.interrupting ? "user" : (full.cause ?? null)) : null,
      error: reason === "error" ? (full.error ?? { message: "The run failed.", code: null }) : null,
      usage: full.usage === undefined || full.usage === null ? null : [...full.usage],
      durationMs: Math.max(0, clock.now().getTime() - entry.startedAt),
      turnCount: full.turnCount ?? null,
      resultText: full.resultText ?? null,
    };
    const letRunGo = (): void => {
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
        entry.append(event);
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

  /**
   * The broker as a session's runs are handed it. A request parks the
   * session's run live at the time it is made (a turn the provider opened on
   * its own asks through the context of the run it followed), under the
   * prompt's id, the adapter's own or one the host mints, until the request
   * settles or `answerPrompt` answers it, whichever comes first.
   */
  const brokerFor = (sessionId: string): PermissionBroker => ({
    request: async (request) => {
      const entry = live.get(sessionId);
      const parks = entry !== undefined && !entry.ended ? entry : undefined;
      const promptId = request.promptId ?? randomUUID();
      if (parks !== undefined) raised(parks, promptId);
      try {
        return await broker.request({ ...request, promptId });
      } finally {
        if (parks !== undefined) answered(parks, promptId);
      }
    },
  });

  const contextFor = (entry: LiveRun): RunContext => ({
    broker: brokerFor(entry.sessionId),
    process: pool.port(entry.sessionId),
    adopt: (turn) => adopt(entry, turn),
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
      run: undefined,
      ended: false,
      unrecorded: false,
      running: false,
      interrupting: false,
      prompts: new Set(),
      received: false,
      launchedWith,
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
    const adapter = accounts.get(account.id)?.adapter ?? adapters.get(account.descriptor.provider);
    if (adapter === undefined) throw new Error(`No adapter serves the provider ${account.descriptor.provider} of the account ${account.id}.`);
    return adapter;
  };

  const launch = (plan: PlannedRun): void => {
    const prompt: PromptMessage[] = plan.prompt.map((message) => {
      const held = heldAttachments.get(message.messageId);
      heldAttachments.delete(message.messageId);
      return held === undefined || message.attachments.length > 0 ? message : { ...message, attachments: held.attachments };
    });
    const scope = { sessionId: plan.sessionId, accountId: plan.account.id, workspace: plan.workspace };
    begin(plan, (entry) =>
      adapterOf(plan.account).createRun(
        {
          sessionId: plan.sessionId,
          runId: plan.runId,
          account: { id: plan.account.id, directory: plan.account.directory },
          workspace: plan.workspace,
          repositoryIdentity: plan.repositoryIdentity,
          model: plan.model,
          effort: plan.effort,
          mode: plan.mode,
          ceiling: plan.policy.mode.ceiling,
          instructions: instructions(scope),
          target: plan.resumeFrom === null ? { kind: "fresh" } : { kind: "resume", providerSessionId: plan.resumeFrom },
          toolServers: toolServers({ ...scope, runId: plan.runId }),
          trusted: false,
          prompt,
        },
        contextFor(entry),
      ),
      prompt,
    );
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
    const letGo = (why: string): void => {
      safely(() => turn.dispose(), (e) => console.error(`Disposing a turn ${why} failed:`, e));
      requeueTurn(previous, turn);
    };
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
      letGo("of a deleted session");
      return;
    }
    try {
      registry.admit();
    } catch {
      letGo("the drain refused");
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
    const policy = resolvePolicy({ actor: { ...actor, ceiling }, requested: session.mode, accountModes: descriptor.modes });
    if ("refused" in policy) return refuse(policy.refused);
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
    const plan: PlannedRun = { ...previous, runId, prompt: [], resumeFrom: null, mode, actor, policy };
    const started: RunStartedPayload = {
      runId,
      accountId: plan.account.id,
      identity: accounts.get(plan.account.id)?.facts.identity ?? null,
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
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn failed:", e));
      requeueTurn(previous, turn);
      return;
    }
    // The provider read them, bytes and all.
    for (const messageId of turn.messageIds) heldAttachments.delete(messageId);
    begin(plan, () => turn);
  };

  /** A provider-opened turn the host will not run: the messages it opened with, still the provider's, are the environment's again. */
  const requeueTurn = (previous: PlannedRun, turn: ProviderTurn): void => {
    try {
      requeue(previous.sessionId, previous.runId, turn.messageIds);
    } catch (error) {
      console.error(`Taking back the messages of a turn of session ${previous.sessionId} failed:`, error);
    }
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
   */
  const startFromQueue = (previous: PlannedRun): void => {
    try {
      if (environmentQueue(reader, previous.sessionId).length === 0) return;
      registry.admit();
      const actor = currentActor(previous.actor);
      if (actor === undefined) {
        console.error(`The queued messages of session ${previous.sessionId} wait: the client session they would run for has been revoked or has expired.`);
        return;
      }
      const facts = startFacts(previous.sessionId, actor);
      const decision = decideStart(facts, {
        origin: "client",
        message: null,
        model: previous.model,
        ...(previous.effort !== null && { effort: previous.effort }),
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
      if (delivered.delivery === "steered") heldAttachments.delete(delivered.messageId);
      return;
    }
    if (event.type === "session.purged") {
      for (const [messageId, staged] of heldAttachments) if (staged.sessionId === event.streamId) heldAttachments.delete(messageId);
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
   * this environment the session's provider is unknown, and the purge records
   * `unsupported` (`sessions/deletion.ts` reads the refusal's reason).
   */
  const adapterOfSession = (sessionId: string): Adapter => {
    const accountId = latestRun(reader, sessionId)?.accountId ?? defaultAccountId;
    const adapter = accountId === null ? undefined : accounts.get(accountId)?.adapter;
    if (adapter === undefined) {
      throw new ContractError({
        code: "invalid_params",
        message: `The provider of session ${sessionId} is not known here, so its transcript cannot be deleted.`,
        data: { reason: "unsupported", capability: "transcriptDelete" },
      });
    }
    return adapter;
  };

  const transcripts: ProviderTranscripts = adapters.list().some((adapter) => adapter.descriptor.transcriptDelete)
    ? {
        deleteTranscript: (sessionId) => {
          const adapter = adapterOfSession(sessionId);
          const remove = capability(adapter.descriptor, "transcriptDelete", adapter.deleteTranscript, "delete a provider transcript", "deleteTranscript");
          return remove.call(adapter, sessionId);
        },
      }
    : {};

  const validateSessionInput: RunParametersCheck = (parameters: RunParameters) => {
    const issues: IssueInput[] = [];
    if (parameters.account !== null && !accounts.has(parameters.account)) {
      issues.push({ code: "custom", path: ["account"], message: `No account ${parameters.account} is on this environment.` });
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
    return issues;
  };

  return {
    adapters,
    runs: registry,
    activeRuns: () => [...live.values()].filter(isLive).map(({ runId, sessionId }) => ({ runId, sessionId })),
    refresh: async () => {
      await Promise.all([...accounts.values()].map(probe));
    },
    account,
    validateSessionInput,
    transcripts,
    admit: () => registry.admit(),
    startFacts,
    live: (sessionId) => liveFacts(live.get(sessionId)),
    liveRun: (runId) => liveFacts(byRunId(runId)),
    unrecorded: (runId) => unrecordedRuns.has(runId),
    launch,
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
      safely(
        () => run?.send(send.message),
        (error) => {
          // The provider did not take it, so the environment holds it: the next run reads it (ADR 0022).
          console.error(`Handing message ${send.message.messageId} to run ${send.runId} failed; the environment holds it:`, error);
          if (!closing) requeue(entry.sessionId, send.runId, [send.message.messageId]);
        },
      );
    },
    interrupt(runId) {
      const entry = byRunId(runId);
      if (entry === undefined || entry.ended || entry.interrupting || entry.run === undefined) return;
      entry.interrupting = true;
      const run = entry.run;
      safely(
        async () => {
          const { stillQueued } = await run.interrupt();
          // What the provider still held comes back to the environment's queue, in its order (ADR 0022). If the run's
          // end came first, its end took back everything the provider held, these among them.
          if (!closing && !entry.ended) requeue(entry.sessionId, runId, stillQueued);
        },
        (error) => {
          // The adapter could not interrupt: the host ends the run itself, interrupted as asked, and disposes it.
          console.error(`Interrupting run ${runId} failed; the host ends it:`, error);
          finish(entry, { type: "end", reason: "interrupted", cause: "user" }, { by: "host", stop: "failed" });
        },
      );
    },
    answerPrompt(runId, promptId, decision) {
      const entry = byRunId(runId);
      const run = entry?.run;
      if (entry === undefined || run === undefined) return;
      const answer = capability(entry.descriptor, "interactivePrompts", run.answerPrompt, "answer a prompt", "answerPrompt");
      answered(entry, promptId);
      safely(() => answer.call(run, promptId, decision), (error) => console.error(`Answering prompt ${promptId} of run ${runId} failed:`, error));
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
      return read.call(held.adapter, refOf(held.config));
    },
    async commands(accountId, workspace) {
      const held = heldAccount(accountId);
      const list = capability(held.adapter.descriptor, "commands", held.adapter.commands, "list commands", "commands");
      return list.call(held.adapter, refOf(held.config), workspace);
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
    },
  };
};
