import type { AdapterHost } from "../adapter/host.js";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import type { CommandContext, MethodHandlers } from "../serve/methods.js";
import { appendRunEvents } from "../sessions/activity-companions.js";
import { readSessionState, type Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { decideReadNow, decideWithdraw } from "./run-decider.js";
import { providerQueue, readSentMessage, readSessionFacts } from "./run-reads.js";

/**
 * The queue's two verbs on the method table (ADR 0022, #228; claude-adapter
 * spec, "Wire methods"): `runs.readNow` and `runs.withdraw`, commands at
 * `runs:drive` beside the other run methods (`run-methods.ts`), whoever
 * holds the queue: the provider (`providerQueue`) or the environment.
 *
 * Read now decides in its transaction, as every run command does: with a
 * run live the host interrupts it once the command has committed (cause
 * `read-now`) and starts the queue's run after its end; with none, the run
 * of the environment's queue starts in the command's own transaction.
 *
 * Withdraw is the one command that must hear from outside the log first: a
 * message the provider holds is its to give back, and whether it still
 * holds it, or has read it, only the provider can say, asynchronously
 * (Claude's cancel-by-id control). So it is a prepared command
 * (`serve/methods.ts`): the provider is asked before the command's
 * transaction, and the transaction then decides on the log as it stands
 * and on what the provider answered. A message the provider gave back
 * before the transaction (an interrupt's requeue meanwhile) is withdrawn
 * from the environment's queue; one it had read is `not_found`, and the log
 * says so with the `message.delivered` its read brings.
 */

export interface QueueVerbOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
  /** The caller as a run's actor: a client session, under its ceiling as it is now. */
  readonly actorOf: (context: CommandContext) => RunActor;
}

/** Where a withdraw of a message this environment does not know keeps its receipt: no session can be named, so the message's own id. */
const messageAggregate = (messageId: string): StreamRef => ({ kind: "message", id: messageId });

export const queueVerbMethods = (options: QueueVerbOptions): MethodHandlers => {
  const { log, host, actorOf } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  return {
    "runs.readNow": (params, context) => {
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const actor = actorOf(context);
      const start = host.startFacts(sessionId, actor);
      const live = host.live(sessionId);
      const decision = decideReadNow({ start, liveRunId: live?.runId ?? null, providerHeld: start.session === null ? [] : providerQueue(reader, sessionId) });
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      const result = { sessionId, interruptedRunId: null, runId: null };
      if (decision.nothing === true) return { aggregate, result };
      // It starts a run, now or after the interrupt: the drain's gate first, so a draining environment refuses it whole.
      host.admit();
      if (decision.interrupt !== undefined) {
        const runId = decision.interrupt;
        context.tx.afterCommit(() => host.readNow(sessionId, actor));
        return { aggregate, result: { ...result, interruptedRunId: runId } };
      }
      const { run } = decision;
      appendRunEvents(log, sessionId, decision.events, { tx: context.tx, actor: context.actor, commandId: context.commandId, correlationId: run.runId });
      context.tx.afterCommit(() => host.launch(run));
      return { aggregate, result: { ...result, runId: run.runId } };
    },

    "runs.withdraw": {
      prepare: async (params) => {
        const messageId = params.messageId.toLowerCase();
        const before = readSentMessage(reader, messageId);
        const session = before === null ? null : readSessionFacts(log, reader, before.sessionId);
        // Only a message the provider holds, of a session still here, is the provider's to give back.
        const asked = before?.heldBy === "provider" && session !== null && !session.deleted ? await host.withdraw(before.sessionId, messageId) : null;
        return (_params, context) => {
          const message = readSentMessage(reader, messageId);
          const aggregate = message === null ? messageAggregate(messageId) : sessionStream(message.sessionId);
          const facts = message === null ? null : readSessionFacts(log, reader, message.sessionId);
          const draft = message === null ? null : (readSessionState(reader, message.sessionId)?.draft ?? null);
          const decision = decideWithdraw({ messageId, message, session: facts, draft, provider: asked });
          if (decision.rejected !== undefined) {
            if (asked?.withdrawn === true) {
              // The provider gave it back, and the log will not record it withdrawn (its session went meanwhile): a deleted
              // session's live run was disposed with what its provider held taken back, so the environment holds it already.
              console.error(`Message ${messageId} was withdrawn at the provider but not recorded: ${decision.rejected.message}`);
            }
            return { aggregate, rejected: decision.rejected };
          }
          // The withdrawal is the run's, correlated to it; the draft is the session's own field, as a rewind's is.
          const [withdrawn, ...drafted] = decision.events;
          const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
          if (withdrawn !== undefined) log.append(aggregate, [withdrawn], { ...attribution, correlationId: decision.runId });
          if (drafted.length > 0) log.append(aggregate, drafted, attribution);
          return { aggregate, result: decision.result };
        };
      },
    },
  };
};
