import { randomUUID } from "node:crypto";
import type { AttachmentInput, Mode, RunOrigin } from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { EventInput, EventLog, StreamRef, Tx } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import type { CommandContext, MethodHandlers } from "../serve/methods.js";
import { appendRunEvents } from "../sessions/activity-companions.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { queueVerbMethods } from "./queue-verbs.js";
import { decideInterrupt, decideSend, decideStart, decideStopTask, type RunFacts, type RunRefusal } from "./run-decider.js";
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
 */

export interface RunMethodsOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
  /**
   * A client session's ceiling as it is now: a change by
   * `access.sessions.setCeiling` applies to the next run even on a socket
   * that authenticated before it. Undefined once it is revoked or expired,
   * which a socket still open finds only in the moment before it is closed:
   * the ceiling it authenticated with stands in then.
   */
  readonly ceilingOf: (clientSessionId: string) => Mode | undefined;
}

/** A run to start with a message: on which session, for whom, from where, and what it asks for. */
export interface RunStart {
  readonly sessionId: string;
  readonly actor: RunActor;
  readonly origin: RunOrigin;
  readonly text: string;
  readonly attachments?: readonly AttachmentInput[] | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly mode?: Mode | undefined;
}

/** A run started (its ids), or why not. */
export type RunStartOutcome = { readonly rejected: RunRefusal } | { readonly rejected?: undefined; readonly runId: string; readonly messageId: string };

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
  if (facts.session !== null && !facts.session.deleted) host.admit();
  const messageId = randomUUID();
  const decision = decideStart(facts, {
    origin: request.origin,
    message: { messageId, text: request.text, attachments: request.attachments ?? [] },
    model: request.model,
    effort: request.effort,
    mode: request.mode,
  });
  if (decision.rejected !== undefined) return { rejected: decision.rejected };
  appendRunEvents(log, sessionId, decision.events, { tx, ...attribution, correlationId: decision.run.runId });
  tx.afterCommit(() => host.launch(decision.run));
  return { runId: decision.run.runId, messageId };
};

/** Where a command on a run it cannot find keeps its receipt: no session can be named, so the run's own id. */
const runAggregate = (runId: string): StreamRef => ({ kind: "run", id: runId });

export const runMethods = (options: RunMethodsOptions): MethodHandlers => {
  const { log, host } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /**
   * Appends a command's events to the session's stream, in its transaction, correlated to the run, with the
   * companions they owe the session (`sessions/activity-companions.ts`): a run's start its unarchive, unsettle and
   * wake, the first user message its generated title.
   */
  const appendIn = (context: CommandContext, sessionId: string, runId: string, events: readonly EventInput[]): void => {
    appendRunEvents(log, sessionId, events, { tx: context.tx, actor: context.actor, commandId: context.commandId, correlationId: runId });
  };

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

  return {
    "runs.start": (params, context) => {
      const aggregate = sessionStream(params.sessionId.toLowerCase());
      const started = startRunIn(log, host, context.tx, { actor: context.actor, commandId: context.commandId }, {
        sessionId: params.sessionId,
        actor: actorOf(context),
        origin: "client",
        text: params.text,
        attachments: params.attachments,
        model: params.model,
        effort: params.effort,
        mode: params.mode,
      });
      if (started.rejected !== undefined) return { aggregate, rejected: started.rejected };
      return { aggregate, result: { runId: started.runId, messageId: started.messageId } };
    },

    "runs.send": (params, context) => {
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const facts = host.startFacts(sessionId, actorOf(context));
      // Only a send that starts a run is a new run; one queued during a live run passes a drain.
      if (facts.session !== null && !facts.session.deleted && facts.live === null) host.admit();
      const decision = decideSend(facts, { messageId: randomUUID(), text: params.text, attachments: params.attachments ?? [] });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      // A queued message's bytes are on disk before anything of it is recorded, so its receipt means a restart keeps them (#185).
      if (decision.queued !== undefined) host.stageAttachments(decision.queued.message);
      appendIn(context, sessionId, decision.result.runId, decision.events);
      if (decision.run !== undefined) {
        const run = decision.run;
        afterCommit(context.tx, () => host.launch(run));
      } else {
        const queued = decision.queued;
        afterCommit(context.tx, () => host.queue(queued));
      }
      return { aggregate, result: decision.result };
    },

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

    // Read now and withdraw, on the provider's queue and the environment's (#228).
    ...queueVerbMethods({ log, host, actorOf }),
  };
};
