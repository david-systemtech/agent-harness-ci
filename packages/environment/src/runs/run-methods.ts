import { randomUUID } from "node:crypto";
import type { AdapterHost } from "../adapter/host.js";
import type { EventInput, EventLog, StreamRef, Tx } from "../event-log/event-log.js";
import type { CommandContext, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { decideInterrupt, decideSend, decideStart, decideStopTask, type RunFacts } from "./run-decider.js";
import { readRun, readSessionFacts, taskStatus } from "./run-reads.js";

/**
 * The run methods on the method table (claude-adapter spec, "Wire
 * methods"): `runs.start`, `runs.send`, `runs.interrupt` and `runs.stopTask`.
 * Each is a command: it reads the facts in its transaction, runs the
 * decider, appends what it decides to the session's stream with the run's
 * id as the correlation, and hands the adapter host its part to do once the
 * transaction has committed, so a run never starts for a command that did
 * not. A new run passes the drain's gate first: while the environment
 * drains, `runs.start`, and a `runs.send` that would start a run, are
 * `unavailable`.
 */

export interface RunMethodsOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
}

/** Where a command on a run it cannot find keeps its receipt: no session can be named, so the run's own id. */
const runAggregate = (runId: string): StreamRef => ({ kind: "run", id: runId });

export const runMethods = (options: RunMethodsOptions): MethodHandlers => {
  const { log, host } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** Appends a command's events to the session's stream, in its transaction, correlated to the run. */
  const appendIn = (context: CommandContext, sessionId: string, runId: string, events: readonly EventInput[]): void => {
    log.append(sessionStream(sessionId), events, { tx: context.tx, actor: context.actor, commandId: context.commandId, correlationId: runId });
  };

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
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const facts = host.startFacts(sessionId, context.clientSession.ceiling);
      if (facts.session !== null && !facts.session.deleted) host.admit();
      const messageId = randomUUID();
      const decision = decideStart(facts, {
        origin: "client",
        message: { messageId, text: params.text, attachments: params.attachments ?? [] },
        model: params.model,
        effort: params.effort,
        mode: params.mode,
      });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      appendIn(context, sessionId, decision.run.runId, decision.events);
      afterCommit(context.tx, () => host.launch(decision.run));
      return { aggregate, result: { runId: decision.run.runId, messageId } };
    },

    "runs.send": (params, context) => {
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const facts = host.startFacts(sessionId, context.clientSession.ceiling);
      // Only a send that starts a run is a new run; one queued during a live run passes a drain.
      if (facts.session !== null && !facts.session.deleted && facts.live === null) host.admit();
      const decision = decideSend(facts, { messageId: randomUUID(), text: params.text, attachments: params.attachments ?? [] });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
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
      return { aggregate, result: { runId, ended: decision.ended } };
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
  };
};
