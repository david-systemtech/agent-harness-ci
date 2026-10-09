import type { PreparedSlash, SlashScope } from "../adapter/slash-resolution.js";
import { randomUUID } from "node:crypto";
import { ContractError, type AttachmentInput, type Mode, type RunOrigin, type RunPolicy, type SendResponse } from "@agent-harness/contracts";
import type { RunAdmission } from "../serve/run-registry.js";
import type { AdapterHost } from "../adapter/host.js";
import type { ClientTool } from "../adapter/seams.js";
import type { EventLog, StreamRef, Tx } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import type { CommandContext, MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import { appendRunEvents } from "../sessions/activity-companions.js";
import { readSummary, type Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import type { AvailabilityWatcher } from "../workspace/availability.js";
import { sessionWorkspace } from "../workspace/session.js";
import { queueVerbMethods } from "./queue-verbs.js";
import { decideInterrupt, decideSend, decideSetModel, decideStart, decideStopTask, type RunFacts, type RunRefusal } from "./run-decider.js";
import { readRun, readSessionFacts, taskStatus } from "./run-reads.js";

/**
 * The run methods on the method table (claude-adapter spec, "Wire
 * methods"): `runs.start`, `runs.send`, `runs.interrupt` and `runs.stopTask`,
 * with `runs.readNow` and `runs.withdraw` from `queue-verbs.ts`.
 * Each is a command: it reads the facts in its transaction, runs the
 * decider, appends what it decides to the session's stream with the run's
 * id as the correlation, and hands the adapter host its part to do once the
 * transaction has committed, so a run never starts for a command that did
 * not. A new run passes the drain's gate first: while the environment
 * drains, `runs.start`, and a `runs.send` that would start a run, are
 * `unavailable`. The one thing done before the commit is staging a queued
 * message's attachment bytes on disk (#185), so its receipt means a restart
 * keeps them; a stage that fails refuses the send `internal`.
 *
 * `runs.start`, `runs.send` and `runs.readNow` look at the session's
 * workspace first (#328): each is a prepared command whose `prepare` has the
 * availability watcher look, which marks the session missing, or clears the
 * mark, before the transaction; the decider then refuses a session marked
 * missing, `conflict` `workspace_missing`. The watcher's looks for one
 * session follow each other, so these commands keep their order for a
 * session; a command on a session not here is answered at once.
 */

export interface RunMethodsOptions {
  readonly log: EventLog;
  readonly beforeContinuation?: (sessionId: string) => Promise<string | null>;
  readonly host: AdapterHost;
  /**
   * A client session's ceiling as it is now: a change by
   * `access.sessions.setCeiling` applies to the next run even on a socket
   * that authenticated before it. Undefined once it is revoked or expired,
   * which a socket still open finds only in the moment before it is closed:
   * the ceiling it authenticated with stands in then.
   */
  readonly ceilingOf: (clientSessionId: string) => Mode | undefined;
  /** What looks at a session's workspace before a run command decides (#328). */
  readonly availability: Pick<AvailabilityWatcher, "check">;
}

/** The run commands that need the session's workspace, and so look at it first. */
type WorkspaceCommand = "runs.start" | "runs.send" | "runs.readNow";

/** A run to start with a message: on which session, for whom, from where, and what it asks for. */
export interface RunStart {
  readonly admission?: RunAdmission | undefined;
  readonly slash?: SlashScope | undefined;
  readonly sessionId: string;
  readonly actor: RunActor;
  readonly origin: RunOrigin;
  readonly text: string;
  readonly attachments?: readonly AttachmentInput[] | undefined;
  readonly model?: string | undefined;
  /** Null for the model's own, whatever the default; the default's when absent. */
  readonly effort?: string | null | undefined;
  readonly mode?: Mode | undefined;
  /** What the run's instructions carry after the composed ones: a completions request's own (#138). */
  readonly appendedInstructions?: string | undefined;
  readonly alwaysOn?: readonly string[] | undefined;
  /** The tools a completions request declared for the caller to run, served to the run (#139). */
  readonly clientTools?: readonly ClientTool[] | undefined;
}

/** A run started (its ids and the policy it was resolved with), or why not. */
export type RunStartOutcome =
  | { readonly rejected: RunRefusal }
  | { readonly rejected?: undefined; readonly runId: string; readonly messageId: string; readonly policy: RunPolicy };

/**
 * Starts a run in the open transaction `tx`, as `runs.start` does for a
 * client session and the environment's `startRun` for a routine, a bot or
 * the completions surface (#131): the facts read for the actor, the drain's
 * gate, the decider (the policy resolved for that actor, #129), its events
 * appended with the companions they owe the session under `attribution`,
 * and the launch once the transaction has committed.
 */
export const startRunIn = (
  log: EventLog,
  host: AdapterHost,
  tx: Tx,
  attribution: { readonly actor: string; readonly commandId?: string },
  request: RunStart,
): RunStartOutcome => {
  const sessionId = request.sessionId.toLowerCase();
  const facts = host.startFacts(sessionId, request.actor);
  if (facts.session !== null && !facts.session.deleted) host.admit(request.admission);
  const messageId = randomUUID();
  const skill = request.slash === undefined ? undefined : host.resolveMessage(request.text, request.slash).skill;
  const decision = decideStart(facts, {
    origin: request.origin,
    message: { messageId, text: request.text, attachments: request.attachments ?? [], ...(skill !== undefined && { skill }) },
    model: request.model,
    effort: request.effort,
    mode: request.mode,
    appendedInstructions: request.appendedInstructions,
    alwaysOn: request.alwaysOn,
    clientTools: request.clientTools,
  });
  if (decision.rejected !== undefined) return { rejected: decision.rejected };
  appendRunEvents(log, sessionId, decision.events, { tx, ...attribution, correlationId: decision.run.runId });
  tx.afterCommit(() => host.launch({ ...decision.run, ...(request.slash === undefined ? { literalPromptId: messageId } : { slash: request.slash }) }, request.admission));
  return { runId: decision.run.runId, messageId, policy: decision.run.policy };
};

/** A message to send a session: on which session, for whom, from where a run it starts comes, and the message. */
export interface RunSend {
  readonly slash?: SlashScope | undefined;
  readonly sessionId: string;
  readonly actor: RunActor;
  readonly origin: RunOrigin;
  readonly text: string;
  readonly attachments?: readonly AttachmentInput[] | undefined;
}

/** A message sent (where it went, and the policy of the run it started when it started one), or why not. */
export type RunSendOutcome =
  | { readonly rejected: RunRefusal }
  | { readonly rejected?: undefined; readonly result: SendResponse; readonly startedPolicy: RunPolicy | null };

/**
 * Sends a session a message in the open transaction `tx`, as `runs.send`
 * does for a client session and the completions surface for a steer (#138;
 * ADR 0022): with no run live it starts one (the drain's gate first), else
 * it queues the message, its attachment bytes staged before anything of it
 * is recorded (#185), and hands the host its part once the transaction has
 * committed.
 */
export const sendIn = (
  log: EventLog,
  host: AdapterHost,
  tx: Tx,
  attribution: { readonly actor: string; readonly commandId?: string },
  request: RunSend,
): RunSendOutcome => {
  const sessionId = request.sessionId.toLowerCase();
  const facts = host.startFacts(sessionId, request.actor);
  // Only a send that starts a run is a new run; one queued during a live run passes a drain.
  if (facts.session !== null && !facts.session.deleted && facts.live === null) host.admit();
  const skill = request.slash === undefined ? undefined : host.resolveMessage(request.text, request.slash).skill;
  const decision = decideSend(facts, { messageId: randomUUID(), text: request.text, attachments: request.attachments ?? [], ...(skill !== undefined && { skill }) }, request.origin);
  if (decision.rejected !== undefined) return { rejected: decision.rejected };
  if (decision.queued !== undefined) host.stageAttachments(decision.queued.message);
  appendRunEvents(log, sessionId, decision.events, { tx, ...attribution, correlationId: decision.result.runId });
  if (decision.run !== undefined) {
    const run = decision.run;
    tx.afterCommit(() => host.launch({ ...run, ...(request.slash !== undefined && { slash: request.slash }) }));
    return { result: decision.result, startedPolicy: run.policy };
  }
  const queued = decision.queued;
  tx.afterCommit(() => host.queue(queued));
  return { result: decision.result, startedPolicy: null };
};

/** Where a command on a run it cannot find keeps its receipt: no session can be named, so the run's own id. */
const runAggregate = (runId: string): StreamRef => ({ kind: "run", id: runId });

export const runMethods = (options: RunMethodsOptions): MethodHandlers => {
  const { log, host, availability } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /**
   * `handler`, run once the availability watcher has looked at the session's
   * workspace and marked it by what it found. A session not here, or
   * deleted, needs no look: its refusal is answered at once, keeping the
   * command's place among its socket's requests.
   */
  const lookingFirst = <N extends WorkspaceCommand>(handler: (params: Parameters<MethodHandler<N>>[0], context: CommandContext, slash?: SlashScope) => ReturnType<MethodHandler<N>>): PreparedCommand<N> => ({
    prepare: async (params) => {
      const sessionId = params.sessionId.toLowerCase();
      if (sessionWorkspace(log, sessionId) === null) return handler;
      await availability.check(sessionId);
      if (host.runActive(sessionId) === null) {
        const unavailable = await options.beforeContinuation?.(sessionId);
        if (unavailable != null) throw new ContractError({ code: "conflict", message: unavailable, data: { reason: "import_source_unavailable" } });
      }
      const text = "text" in params ? params.text : null;
      let slash: PreparedSlash | undefined;
      if (typeof text === "string" && text.startsWith("/")) {
        const facts = host.startFacts(sessionId, { kind: "client", ceiling: "acceptEdits", clientSessionId: null });
        if ((facts.live !== null || facts.account?.signedIn === true) && facts.session?.workspaceMissingSince === null) slash = await host.prepareSlash(sessionId);
      }
      return Object.assign((prepared: Parameters<MethodHandler<N>>[0], context: CommandContext) => handler(prepared, context, slash), {
        isCurrent: () => slash?.isCurrent() !== false,
      });
    },
  });

  /** The caller as a run's actor (#129): a client session, attended, under its ceiling as it is now. */
  const actorOf = (context: CommandContext): RunActor => ({
    kind: "client",
    ceiling: options.ceilingOf(context.clientSession.id) ?? context.clientSession.ceiling,
    clientSessionId: context.clientSession.id,
  });

  /** Runs `work` once the command's transaction has committed. */
  const afterCommit = (tx: Tx, work: () => void): void => tx.afterCommit(work);

  /** The facts about a run a command names. */
  const runFacts = (runId: string): RunFacts => {
    const run = readRun(reader, runId);
    return {
      runId,
      run,
      session: run === null ? null : readSessionFacts(log, reader, run.sessionId),
      live: host.liveRun(runId)?.descriptor ?? null,
      descriptor: run === null ? null : (host.account(run.accountId)?.descriptor ?? null),
    };
  };

  const verbs = queueVerbMethods({ log, host, actorOf });

  return {
    "runs.start": lookingFirst((params, context, slash) => {
      const aggregate = sessionStream(params.sessionId.toLowerCase());
      const started = startRunIn(log, host, context.tx, { actor: context.actor, commandId: context.commandId }, {
        sessionId: params.sessionId,
        actor: actorOf(context),
        origin: "client",
        text: params.text,
        slash,
        attachments: params.attachments,
        model: params.model,
        effort: params.effort,
        mode: params.mode,
      });
      if (started.rejected !== undefined) return { aggregate, rejected: started.rejected };
      return { aggregate, result: { runId: started.runId, messageId: started.messageId } };
    }),

    "runs.send": lookingFirst((params, context, slash) => {
      const aggregate = sessionStream(params.sessionId.toLowerCase());
      const sent = sendIn(log, host, context.tx, { actor: context.actor, commandId: context.commandId }, {
        sessionId: params.sessionId,
        actor: actorOf(context),
        origin: "client",
        text: params.text,
        slash,
        attachments: params.attachments,
      });
      if (sent.rejected !== undefined) return { aggregate, rejected: sent.rejected };
      return { aggregate, result: sent.result };
    }),

    "runs.interrupt": (params, context) => {
      const runId = params.runId.toLowerCase();
      const facts = runFacts(runId);
      const aggregate = facts.run === null ? runAggregate(runId) : sessionStream(facts.run.sessionId);
      const decision = decideInterrupt(facts);
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      if (!decision.ended) afterCommit(context.tx, () => host.interrupt(runId));
      // A run whose end the log could not take is over here all the same: ended, and said to be unrecorded.
      return { aggregate, result: { runId, ended: decision.ended, ...(decision.ended && host.unrecorded(runId) && { unrecorded: true }) } };
    },

    "runs.stopTask": (params, context) => {
      const runId = params.runId.toLowerCase();
      const facts = runFacts(runId);
      const aggregate = facts.run === null ? runAggregate(runId) : sessionStream(facts.run.sessionId);
      const decision = decideStopTask(facts, taskStatus(reader, runId, params.taskId));
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      if (!decision.ended) afterCommit(context.tx, () => host.stopTask(runId, params.taskId));
      return { aggregate, result: { runId, taskId: params.taskId, ended: decision.ended } };
    },

    // The model and effort the session's next runs go out on (#1961): the session's own, kept in its stream; at runs:drive.
    "sessions.setModel": (params, context) => {
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const decision = decideSetModel(host.startFacts(sessionId, actorOf(context)), { model: params.model, effort: params.effort });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      if (decision.event !== null) log.append(aggregate, [decision.event], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      const summary = readSummary(reader, sessionId);
      if (summary === null) throw new Error(`The session ${sessionId} has no summary after its model was chosen.`);
      return { aggregate, result: { summary } };
    },

    // Read now and withdraw, on the provider's queue and the environment's (#228); read now looks at the workspace first.
    "runs.readNow": lookingFirst(verbs["runs.readNow"]),
    "runs.withdraw": verbs["runs.withdraw"],
  };
};
