import { randomUUID } from "node:crypto";
import {
  ContractError,
  SESSION_STREAM_KIND,
  type AccountIdentity,
  type IssueInput,
  type MessageDeliveredPayload,
  type MessageRequeuedPayload,
  type RunEndedPayload,
  type RunStartedPayload,
  type Workspace,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type EventInput } from "../event-log/event-log.js";
import { environmentQueue, latestRun, providerHeld, providerSessionOf, readRun, readSessionFacts } from "../runs/run-reads.js";
import { decideStart, type AccountFacts, type LiveRunFacts, type PlannedRun, type QueuedSend, type StartFacts } from "../runs/run-decider.js";
import type { Clock } from "../serve/clock.js";
import { createRunRegistry, type MemoryRunRegistry } from "../serve/run-registry.js";
import type { ProviderTranscripts } from "../sessions/deletion.js";
import type { RunParameters, RunParametersCheck } from "../sessions/run-parameters.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
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
import { createAdapterRegistry, type AdapterRegistry } from "./registry.js";
import { createScopedAppend, type ScopedAppend } from "./scoped-append.js";
import {
  autoDenyBroker,
  composeInstructions,
  identityClamp,
  noToolServers,
  type InstructionComposer,
  type ModeClamp,
  type ToolServerFactory,
} from "./seams.js";

/**
 * The adapter host (claude-adapter spec, "Modules and ownership" and "The
 * adapter contract"; ADR 0015): what stands between the adapters and the
 * rest of the environment. It holds the adapter registry and the accounts'
 * sign-in states and catalogues, fills the run registry the lifecycle reads
 * for idle and drain (#112), and supplies each run with its seams (tool
 * servers, composed instructions, the broker, the mode clamp). It starts a
 * run through its adapter once the command that asked for it has committed,
 * consumes the run's event stream once, appending each event through the
 * run's scoped append and nothing else, and appends the run's one
 * `run.ended` on every path. A run belongs to the environment, not to the
 * client that started it: nothing a socket does ends one.
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
  readonly clampMode?: ModeClamp;
  /** How long an account's status or model probe may take before it counts as failed, so a hung probe cannot hang startup. Preset: `PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
  /** Where the bytes of sent messages' attachments wait until a run reads them, by message id. Preset: a fresh in-memory map (#120 stages them on disk). */
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
  /** What starting a run on the session depends on, read now (inside a command, in its transaction). */
  startFacts(sessionId: string, ceiling: string): StartFacts;
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
  /** Plan usage for an account, with its identity (`planUsage`). */
  usage(accountId: string): Promise<UsageReading>;
  /** The slash commands for an account and workspace (`commands`). */
  commands(accountId: string, workspace: Workspace): Promise<readonly ProviderCommand[]>;
  /** Ends every live run (`disposed`, or `drained` when a drain's cap cut it) and stops taking events: the environment is closing. */
  close(reason: "disposed" | "drained"): void;
}

/** The host's own actor, for the run events it decides on itself: an end it appends, a run it starts from the queue. */
export const HOST_ACTOR = formatActor({ kind: "system", id: "adapter-host" });

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
   * recovery sweep (#120) appends one at the next start.
   */
  unrecorded: boolean;
  running: boolean;
  interrupting: boolean;
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
  try {
    const answer = work();
    if (answer instanceof Promise) answer.catch(onError);
  } catch (error) {
    onError(error);
  }
};

export const createAdapterHost = (options: AdapterHostOptions): AdapterHost => {
  const { log, clock } = options;
  const adapters = createAdapterRegistry(options.adapters ?? []);
  const registry = options.runs ?? createRunRegistry({ clock });
  const toolServers = options.toolServers ?? noToolServers;
  const instructions = options.instructions ?? composeInstructions();
  const broker = options.broker ?? autoDenyBroker;
  const clamp = options.clampMode ?? identityClamp;
  const configs = options.accounts ?? [];
  const defaultAccountId = options.defaultAccountId ?? configs[0]?.id ?? null;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const accounts = new Map<string, HeldAccount>();
  /** Live runs by session: at most one each. */
  const live = new Map<string, LiveRun>();
  /** Runs that ended here with their end not in the log. */
  const unrecordedRuns = new Set<string>();
  /** Turns a provider opened while the run before them was still live, waiting for it to end, each with the run it followed. */
  const adoptions = new Map<string, { readonly previous: PlannedRun; readonly turn: ProviderTurn }[]>();
  /**
   * The bytes of the attachments of messages sent during a run, whoever
   * holds them, until a run reads them (the launch of a run of the queue, a
   * steer's `message.delivered`, an adopted turn), since an interrupt may hand
   * a provider-held message back; a purged session's are dropped. They are
   * never logged, and not kept across a restart (#120).
   */
  const heldAttachments = options.stagedAttachments ?? new Map<string, StagedAttachments>();
  let closing = false;

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
    entry === undefined || !isLive(entry) ? null : { runId: entry.runId, descriptor: entry.descriptor };

  const append = (sessionId: string, runId: string, actor: string, events: readonly EventInput[]): void => {
    if (events.length > 0) log.append(sessionStream(sessionId), events, { actor, correlationId: runId });
  };

  /** `message.requeued` for each message: the environment holds it now (ADR 0022). Always the host's. */
  const requeued = (runId: string, messageIds: readonly string[]): EventInput[] =>
    messageIds.map((messageId): EventInput => {
      const payload: MessageRequeuedPayload = { runId, messageId };
      return { type: "message.requeued", payload };
    });

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
    append(entry.sessionId, entry.runId, HOST_ACTOR, requeued(entry.runId, read));
  };

  /** Takes back into the environment's queue the messages of `runId` that the provider still holds, of `messageIds` or all. */
  const requeue = (sessionId: string, runId: string, messageIds?: readonly string[]): void => {
    const held = providerHeld(reader, sessionId, runId).filter((messageId) => messageIds === undefined || messageIds.includes(messageId));
    append(sessionId, runId, HOST_ACTOR, requeued(runId, held));
  };

  const startFacts = (sessionId: string, ceiling: string): StartFacts => {
    const session = readSessionFacts(log, reader, sessionId);
    const accountId = session?.account ?? defaultAccountId;
    const facts = account(accountId);
    return {
      sessionId,
      session,
      live: liveFacts(live.get(sessionId)),
      accountId,
      account: facts,
      queued: environmentQueue(reader, sessionId),
      resumeFrom: facts?.descriptor.resume === true ? providerSessionOf(reader, sessionId) : null,
      ceiling,
      clamp,
      runId: randomUUID(),
    };
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
   * If the end cannot be appended, the log still says the run is live, and
   * so does the host: the run stays in the run registry and the session
   * keeps it as its live run (a start is `run_active`) until a restart's
   * recovery sweep (#120) ends it; the failure is logged loudly, and the
   * adapter's run is let go as it would have been.
   */
  const finish = (
    entry: LiveRun,
    end: RunEnd | { readonly type: "end"; readonly reason: "disposed" | "drained" },
    by: "adapter" | "host",
    letGo: "dispose" | "release" = by === "host" || end.reason === "disposed" || end.reason === "drained" ? "dispose" : "release",
  ): void => {
    // Synchronous, before anything else: exactly one end per run rests on this flag (see `LiveRun.ended`).
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
      if (letGo === "dispose") safely(() => entry.run?.dispose(), (e) => console.error(`Disposing run ${entry.runId} failed:`, e));
      else safely(() => entry.run?.release(), (e) => console.error(`Releasing run ${entry.runId} failed:`, e));
    };
    const record = (): void =>
      log.atomically(() => {
        // A run whose adapter never had its input read none of it: what it was launched with is the environment's queue again.
        if (!entry.received) requeueUnread(entry);
        if (by === "host" || reason !== "completed") requeue(entry.sessionId, entry.runId);
        append(entry.sessionId, entry.runId, by === "adapter" ? entry.actor : HOST_ACTOR, [{ type: "run.ended", payload }]);
      });
    try {
      try {
        record();
      } catch (first) {
        console.error(`Appending the end of run ${entry.runId} failed; trying once more:`, first);
        record();
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
    const [adopted, ...rest] = adoptions.get(entry.sessionId) ?? [];
    if (adopted !== undefined) {
      if (rest.length > 0) adoptions.set(entry.sessionId, rest);
      else adoptions.delete(entry.sessionId);
      adoptNow(adopted.previous, adopted.turn);
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
          finish(entry, event, "adapter");
          break;
        }
        if (!entry.running) {
          entry.running = true;
          registry.running(entry.runId);
        }
        entry.append(event);
      }
      if (!entry.ended) finish(entry, { type: "end", reason: "error", error: { message: "The run's event stream stopped without an end.", code: "no_end" } }, "host");
    } catch (error) {
      if (!entry.ended) finish(entry, { type: "end", reason: "error", error: { message: messageOf(error), code: null } }, "host");
    }
  };

  const contextFor = (entry: LiveRun): RunContext => ({
    broker,
    adopt: (turn) => adopt(entry.plan, turn),
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
      run: undefined,
      ended: false,
      unrecorded: false,
      running: false,
      interrupting: false,
      received: false,
      launchedWith,
    };
    // Admitted first: a drain that refuses it leaves no live entry behind.
    registry.start(plan.runId);
    live.set(plan.sessionId, entry);
    try {
      entry.run = create(entry);
      entry.received = true;
    } catch (error) {
      queueMicrotask(() => finish(entry, { type: "end", reason: "error", error: { message: messageOf(error), code: null } }, "host"));
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

  /**
   * Registers a turn the provider opened on its own as a run of the same
   * session (the adoption hook): `run.started` with origin `provider`, the
   * queued messages it opened with delivered, then its events like any
   * run's. The account, model and mode are those of the run it followed.
   * While the environment drains it is not admitted, and is disposed.
   */
  const adoptNow = (previous: PlannedRun, turn: ProviderTurn): void => {
    const runId = randomUUID();
    const session = readSessionFacts(log, reader, previous.sessionId);
    if (session === null || session.deleted) {
      // Deleted (or purged) since the run it followed: no run of it may start; what the turn was to read goes back.
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn of a deleted session failed:", e));
      requeueTurn(previous, turn);
      return;
    }
    try {
      registry.admit();
    } catch {
      // The drain refuses the turn: what it opened with comes back to the environment's queue for the next start.
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn the drain refused failed:", e));
      requeueTurn(previous, turn);
      return;
    }
    const plan: PlannedRun = { ...previous, runId, prompt: [], resumeFrom: null };
    const started: RunStartedPayload = {
      runId,
      accountId: plan.account.id,
      identity: accounts.get(plan.account.id)?.facts.identity ?? null,
      model: plan.model,
      effort: plan.effort,
      mode: { requested: plan.requestedMode, effective: plan.mode, clamped: plan.requestedMode !== plan.mode },
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
    append(plan.sessionId, runId, formatActor({ kind: "adapter", id: plan.account.descriptor.provider }), [{ type: "run.started", payload: started }, ...delivered]);
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
    for (const { previous, turn } of adoptions.get(sessionId) ?? []) {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn failed:", e));
      requeueTurn(previous, turn);
    }
    adoptions.delete(sessionId);
  };

  const adopt = (previous: PlannedRun, turn: ProviderTurn): void => {
    if (closing) {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn adopted while closing failed:", e));
      requeueTurn(previous, turn);
      return;
    }
    const current = live.get(previous.sessionId);
    if (current !== undefined && isLive(current)) {
      adoptions.set(previous.sessionId, [...(adoptions.get(previous.sessionId) ?? []), { previous, turn }]);
      return;
    }
    adoptNow(previous, turn);
  };

  /**
   * After a run completed or failed, starts the next with the messages the
   * environment holds for the session, if any (ADR 0022: an adapter without
   * a provider queue reads its queue when the turn ends). Not while the
   * environment drains: the messages stay queued for the next start.
   */
  const startFromQueue = (previous: PlannedRun): void => {
    try {
      if (environmentQueue(reader, previous.sessionId).length === 0) return;
      registry.admit();
      const facts = startFacts(previous.sessionId, previous.ceiling);
      const decision = decideStart(facts, {
        origin: "client",
        message: null,
        model: previous.model,
        ...(previous.effort !== null && { effort: previous.effort }),
        ...(previous.requestedMode !== null && { mode: previous.requestedMode }),
      });
      if (decision.rejected !== undefined) {
        console.error(`The queued messages of session ${previous.sessionId} could not start a run: ${decision.rejected.message}`);
        return;
      }
      append(previous.sessionId, decision.run.runId, HOST_ACTOR, decision.events);
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
    if (entry !== undefined) finish(entry, { type: "end", reason: "disposed" }, "host");
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
      else if (!facts.descriptor.modes.includes(parameters.mode)) {
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
          finish(entry, { type: "end", reason: "interrupted", cause: "user" }, "host");
        },
      );
    },
    stopTask(runId, taskId) {
      const entry = byRunId(runId);
      const run = entry?.run;
      if (entry === undefined || run === undefined) return;
      const stop = capability(entry.descriptor, "subagents", run.stopTask, "stop delegated work", "stopTask");
      safely(() => stop.call(run, taskId), (error) => console.error(`Stopping task ${taskId} of run ${runId} failed:`, error));
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
    close(reason) {
      if (closing) return;
      closing = true;
      unsubscribe();
      for (const entry of [...live.values()]) finish(entry, { type: "end", reason }, "host");
      for (const sessionId of [...adoptions.keys()]) dropAdoptions(sessionId);
    },
  };
};
