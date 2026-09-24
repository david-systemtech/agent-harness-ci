import { randomUUID } from "node:crypto";
import {
  SESSION_STREAM_KIND,
  type AccountIdentity,
  type IssueInput,
  type MessageDeliveredPayload,
  type MessageRequeuedPayload,
  type Mode,
  type RunEndedPayload,
  type RunStartedPayload,
  type Workspace,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type EventInput } from "../event-log/event-log.js";
import { environmentQueue, latestRun, providerSessionOf, readSessionFacts } from "../runs/run-reads.js";
import type { RunActor } from "../permissions/resolver.js";
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
  /** The mode the provider runs it in now: its policy's, until a live change (`setMode`) takes. */
  mode: Mode;
  run: AdapterRun | undefined;
  /** Set once its `run.ended` is appended; nothing of it is appended after. */
  ended: boolean;
  running: boolean;
  interrupting: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  const resolvePolicy = options.resolvePolicy ?? presetPolicy;
  const configs = options.accounts ?? [];
  const defaultAccountId = options.defaultAccountId ?? configs[0]?.id ?? null;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const accounts = new Map<string, HeldAccount>();
  /** Live runs by session: at most one each. */
  const live = new Map<string, LiveRun>();
  /** Turns a provider opened while the run before them was still live, waiting for it to end. */
  const adoptions = new Map<string, ProviderTurn[]>();
  /** The bytes of the attachments of messages the environment holds, until a run reads them. They are never logged. */
  const heldAttachments = new Map<string, readonly AttachmentData[]>();
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
      const status = await held.adapter.status(ref);
      signedIn = status.signedIn;
      if (status.signedIn && status.email !== null) identity = { provider, email: status.email, organisation: status.orgName };
    } catch (error) {
      console.error(`Reading the status of the account ${held.config.id} failed:`, error);
    }
    let models = held.facts.models;
    try {
      models = (await held.adapter.models(ref)).models;
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

  const byRunId = (runId: string): LiveRun | undefined => [...live.values()].find((entry) => entry.runId === runId && !entry.ended);

  const liveFacts = (entry: LiveRun | undefined): LiveRunFacts | null =>
    entry === undefined || entry.ended ? null : { runId: entry.runId, descriptor: entry.descriptor, policy: entry.plan.policy };

  const append = (sessionId: string, runId: string, actor: string, events: readonly EventInput[]): void => {
    if (events.length > 0) log.append(sessionStream(sessionId), events, { actor, correlationId: runId });
  };

  const startFacts = (sessionId: string, actor: RunActor): StartFacts => {
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
      actor,
      resolvePolicy,
      runId: randomUUID(),
    };
  };

  /**
   * Ends a run, once: appends its `run.ended`, marks it ended in the run
   * registry and lets its adapter go. `by` says who ended it: its adapter,
   * whose end event it records, or the host (a stream that failed or stopped
   * without an end, a dispose), whose end it records as its own. Then the
   * session's next run, if one is owed: a turn the provider opened meanwhile,
   * or the environment's queue after a run that completed or failed.
   */
  const finish = (
    entry: LiveRun,
    end: RunEnd | { readonly type: "end"; readonly reason: "disposed" | "drained" },
    by: "adapter" | "host",
    letGo: "dispose" | "release" = end.reason === "disposed" || end.reason === "drained" ? "dispose" : "release",
  ): void => {
    if (entry.ended) return;
    entry.ended = true;
    const reason = end.reason;
    const full = end as Partial<RunEnd>;
    const error = reason === "error" ? (full.error ?? { message: "The run failed.", code: null }) : null;
    const payload: RunEndedPayload = {
      runId: entry.runId,
      reason,
      cause: reason === "interrupted" ? (entry.interrupting ? "user" : (full.cause ?? "user")) : null,
      error,
      usage: full.usage === undefined || full.usage === null ? null : [...full.usage],
      durationMs: Math.max(0, clock.now().getTime() - entry.startedAt),
      turnCount: full.turnCount ?? null,
      resultText: full.resultText ?? null,
    };
    try {
      append(entry.sessionId, entry.runId, by === "adapter" ? entry.actor : HOST_ACTOR, [{ type: "run.ended", payload }]);
    } catch (appendError) {
      console.error(`Appending the end of run ${entry.runId} failed:`, appendError);
    }
    registry.end(entry.runId);
    if (live.get(entry.sessionId) === entry) live.delete(entry.sessionId);
    if (letGo === "dispose") safely(() => entry.run?.dispose(), (e) => console.error(`Disposing run ${entry.runId} failed:`, e));
    else safely(() => entry.run?.release(), (e) => console.error(`Releasing run ${entry.runId} failed:`, e));
    if (closing || reason === "disposed" || reason === "drained") return;
    const [adopted, ...rest] = adoptions.get(entry.sessionId) ?? [];
    if (adopted !== undefined) {
      if (rest.length > 0) adoptions.set(entry.sessionId, rest);
      else adoptions.delete(entry.sessionId);
      adoptNow(entry, adopted);
      return;
    }
    if (reason !== "interrupted") startFromQueue(entry.plan);
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
    adopt: (turn) => adopt(entry, turn),
  });

  /**
   * Registers a run and starts consuming it; the run's own events are
   * appended by then. `create` is everything that can fail on the way to the
   * live run (the seams, the adapter's `createRun`): a throw ends the run
   * `error`, one microtask on, so that when the run was launched after a
   * command's commit its end is heard after the command's own events.
   */
  const begin = (plan: PlannedRun, create: (entry: LiveRun) => AdapterRun): void => {
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
      running: false,
      interrupting: false,
    };
    live.set(plan.sessionId, entry);
    registry.start(plan.runId);
    try {
      entry.run = create(entry);
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
      return held === undefined || message.attachments.length > 0 ? message : { ...message, attachments: held };
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
    );
  };

  /** `actor` with its client session's ceiling as it is now; undefined once that client session is revoked or expired. */
  const currentActor = (actor: RunActor): RunActor | undefined => {
    if (actor.clientSessionId === null) return actor;
    const ceiling = options.ceilingOf(actor.clientSessionId);
    return ceiling === undefined ? undefined : { ...actor, ceiling };
  };

  /**
   * Lets a turn the provider opened go without a run of its own: the
   * provider stops it, and the messages it opened with come back to the
   * environment's queue (`message.requeued`, under the run they were sent
   * during), for the next run to read, which is started from the queue now
   * if it can be.
   */
  const refuseTurn = (previous: PlannedRun, turn: ProviderTurn, why: string): void => {
    console.error(`A turn the provider opened for session ${previous.sessionId} was let go: ${why}`);
    safely(() => turn.dispose(), (e) => console.error("Disposing a turn failed:", e));
    const requeued = turn.messageIds.map((messageId): EventInput => {
      const payload: MessageRequeuedPayload = { runId: previous.runId, messageId };
      return { type: "message.requeued", payload };
    });
    try {
      append(previous.sessionId, previous.runId, HOST_ACTOR, requeued);
    } catch (error) {
      console.error(`Returning the messages of a turn of session ${previous.sessionId} to the queue failed:`, error);
      return;
    }
    startFromQueue(previous);
  };

  /**
   * Registers a turn the provider opened on its own as a run of the same
   * session (the adoption hook): `run.started` with origin `provider`, its
   * policy, the queued messages it opened with delivered, then its events
   * like any run's. The account and model are those of the run it followed;
   * the policy is resolved again, for the same actor under its ceiling as it
   * is now and the session's mode as it is now, as a run from the queue
   * would be. When that is not the mode the provider runs the turn in, the
   * turn is changed to it (`modeChange`); when it cannot be, or the actor's
   * client session is gone, or no mode is available, the turn is let go and
   * its messages wait in the environment's queue. While the environment
   * drains it is not admitted, and is disposed.
   */
  const adoptNow = (followed: LiveRun, turn: ProviderTurn): void => {
    const previous = followed.plan;
    const runId = randomUUID();
    try {
      registry.admit();
    } catch {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn the drain refused failed:", e));
      return;
    }
    const session = readSessionFacts(log, reader, previous.sessionId);
    if (session === null || session.deleted) {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn of a deleted session failed:", e));
      return;
    }
    const actor = currentActor(previous.actor);
    if (actor === undefined) return refuseTurn(previous, turn, "the client session its run was started for has been revoked or has expired.");
    const { descriptor } = previous.account;
    const policy = resolvePolicy({ actor, requested: session.mode, accountModes: descriptor.modes });
    if ("refused" in policy) return refuseTurn(previous, turn, policy.refused);
    const mode = policy.mode.effective;
    if (mode !== followed.mode) {
      if (!descriptor.modeChange || turn.setMode === undefined) {
        return refuseTurn(previous, turn, `it runs in ${followed.mode}, the policy now resolves ${mode}, and the adapter cannot change a running turn's mode.`);
      }
      const setMode = turn.setMode;
      safely(() => setMode.call(turn, mode), (e) => console.error(`Changing the mode of a turn of session ${previous.sessionId} failed:`, e));
    }
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
    append(plan.sessionId, runId, formatActor({ kind: "adapter", id: descriptor.provider }), [
      { type: "run.started", payload: started },
      policyResolvedEvent(runId, policy),
      ...delivered,
    ]);
    begin(plan, () => turn);
  };

  const adopt = (followed: LiveRun, turn: ProviderTurn): void => {
    const previous = followed.plan;
    if (closing) {
      safely(() => turn.dispose(), (e) => console.error("Disposing a turn adopted while closing failed:", e));
      return;
    }
    const current = live.get(previous.sessionId);
    if (current !== undefined && !current.ended) {
      adoptions.set(previous.sessionId, [...(adoptions.get(previous.sessionId) ?? []), turn]);
      return;
    }
    adoptNow(followed, turn);
  };

  /**
   * After a run completed or failed, starts the next with the messages the
   * environment holds for the session, if any (ADR 0022: an adapter without
   * a provider queue reads its queue when the turn ends), for the actor of
   * the run before it under its ceiling as it is now and in the session's
   * mode as it is now: the run before it may have named a mode of its own,
   * which was that run's alone. Not while the environment drains, nor once
   * that actor's client session is revoked or expired: the messages stay
   * queued for the next start.
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
      append(previous.sessionId, decision.run.runId, HOST_ACTOR, decision.events);
      launch(decision.run);
    } catch (error) {
      console.error(`Starting the next run of session ${previous.sessionId} from its queue failed:`, error);
    }
  };

  // A deleted session's live run is let go: nothing more of it may reach a stream a purge will remove.
  const unsubscribe = log.subscribe((event) => {
    if (event.streamKind !== SESSION_STREAM_KIND || event.type !== "session.deleted") return;
    for (const turn of adoptions.get(event.streamId) ?? []) safely(() => turn.dispose(), (e) => console.error("Disposing a turn failed:", e));
    adoptions.delete(event.streamId);
    const entry = live.get(event.streamId);
    if (entry !== undefined) finish(entry, { type: "end", reason: "disposed" }, "host");
  });

  /** The adapter that holds a session's provider transcript: its latest run's account's, else the default account's. */
  const adapterOfSession = (sessionId: string): Adapter => {
    const accountId = latestRun(reader, sessionId)?.accountId ?? defaultAccountId;
    const held = accountId === null ? undefined : accounts.get(accountId);
    const adapter = held?.adapter ?? adapters.list()[0];
    if (adapter === undefined) throw new Error("No adapter is registered on this environment.");
    return adapter;
  };

  const transcripts: ProviderTranscripts = adapters.list().some((adapter) => adapter.descriptor.transcriptDelete)
    ? {
        deleteTranscript: (sessionId) => {
          const adapter = adapterOfSession(sessionId);
          const remove = capability(adapter.descriptor, "transcriptDelete", adapter.deleteTranscript, "delete a provider transcript");
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
    activeRuns: () => [...live.values()].filter((entry) => !entry.ended).map(({ runId, sessionId }) => ({ runId, sessionId })),
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
    launch,
    queue(send) {
      const entry = byRunId(send.runId);
      if (send.heldBy === "environment" || entry === undefined) {
        heldAttachments.set(send.message.messageId, send.message.attachments);
        return;
      }
      const run = entry.run;
      safely(
        () => run?.send(send.message),
        (error) => {
          // The provider did not take it, so the environment holds it: the next run reads it (ADR 0022).
          console.error(`Handing message ${send.message.messageId} to run ${send.runId} failed; the environment holds it:`, error);
          heldAttachments.set(send.message.messageId, send.message.attachments);
          const payload: MessageRequeuedPayload = { runId: send.runId, messageId: send.message.messageId };
          if (!closing) append(entry.sessionId, send.runId, HOST_ACTOR, [{ type: "message.requeued", payload }]);
        },
      );
    },
    interrupt(runId) {
      const entry = byRunId(runId);
      if (entry === undefined || entry.interrupting || entry.run === undefined) return;
      entry.interrupting = true;
      const run = entry.run;
      safely(
        async () => {
          const { stillQueued } = await run.interrupt();
          // The provider's still-queued messages come back to the environment's queue, in their order (ADR 0022).
          const requeued = stillQueued.map((messageId): EventInput => {
            const payload: MessageRequeuedPayload = { runId, messageId };
            return { type: "message.requeued", payload };
          });
          if (!closing) append(entry.sessionId, runId, entry.actor, requeued);
        },
        (error) => {
          // The adapter could not interrupt: the host ends the run itself, interrupted as asked, and lets it go.
          console.error(`Interrupting run ${runId} failed; the host ends it:`, error);
          finish(entry, { type: "end", reason: "interrupted", cause: "user" }, "host", "dispose");
        },
      );
    },
    stopTask(runId, taskId) {
      const entry = byRunId(runId);
      const run = entry?.run;
      if (entry === undefined || run === undefined) return;
      const stop = capability(entry.descriptor, "subagents", run.stopTask, "stop delegated work");
      safely(() => stop.call(run, taskId), (error) => console.error(`Stopping task ${taskId} of run ${runId} failed:`, error));
    },
    setMode(runId, mode) {
      const entry = byRunId(runId);
      const run = entry?.run;
      if (entry === undefined || run === undefined) return;
      const failed = (error: unknown) => console.error(`Changing the mode of run ${runId} failed; it keeps ${entry.mode} until its session's next run:`, error);
      safely(() => {
        const answer = capability(entry.descriptor, "modeChange", run.setMode, "change a live run's mode").call(run, mode);
        if (answer instanceof Promise) return answer.then(() => void (entry.mode = mode));
        entry.mode = mode;
        return undefined;
      }, failed);
    },
    async usage(accountId) {
      const held = heldAccount(accountId);
      const read = capability(held.adapter.descriptor, "planUsage", held.adapter.usage, "read plan usage");
      return read.call(held.adapter, refOf(held.config));
    },
    async commands(accountId, workspace) {
      const held = heldAccount(accountId);
      const list = capability(held.adapter.descriptor, "commands", held.adapter.commands, "list commands");
      return list.call(held.adapter, refOf(held.config), workspace);
    },
    close(reason) {
      if (closing) return;
      closing = true;
      unsubscribe();
      for (const entry of [...live.values()]) finish(entry, { type: "end", reason }, "host");
      for (const turns of adoptions.values()) for (const turn of turns) safely(() => turn.dispose(), (e) => console.error("Disposing a turn failed:", e));
      adoptions.clear();
    },
  };
};
