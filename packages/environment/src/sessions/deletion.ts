import type { ProviderTranscriptOutcome, SessionPurgedPayload } from "@agent-harness/contracts";
import { SYSTEM } from "../auth/access-log.js";
import { formatActor, type EventEnvelope, type EventLog, type Tx } from "../event-log/event-log.js";
import { sessionStream } from "./streams.js";

/**
 * The purge (session-state spec, "Deletion, grace and purge"; env spec,
 * "Deletion"): what `sessions.purge` runs at once and the sweep runs for
 * every deleted session whose grace period has passed. In one transaction it
 * deletes the session's events and snapshot from the log, has the adapter
 * delete the provider's transcript when the delete asked for it and the
 * adapter offers it, and appends `session.purged`, whose projection removes
 * the session's rows and tags: the tombstone is then the only event on the
 * session's stream, at stream version 1, and the command receipts are left
 * alone. Deciding whether a session may be purged is the decider's
 * (`decidePurge`); this module carries it out.
 */

/**
 * What the purge needs of the adapter (the adapter host, #119, supplies it):
 * the capability to delete the provider's own transcript of a session,
 * present only when the adapter declares it.
 *
 * - **Synchronous**: it runs inside the purge's transaction, which holds the
 *   log's write lock, and answers before it returns. One that answers with a
 *   promise fails the purge, which commits nothing; the call it started is
 *   left to finish on its own.
 * - **Irreversible**: once it returns the transcript is gone, whatever
 *   becomes of the transaction.
 * - **Idempotent**: the purge calls it last, just before its tombstone, but a
 *   tombstone that fails to commit rolls the purge back and the sweep calls
 *   it again a minute later, for a transcript already deleted; that call
 *   must succeed (or throw, which is recorded as `failed`).
 *
 * A throw is recorded in the tombstone as `failed` with its message, and the
 * session is purged all the same.
 */
export interface ProviderTranscripts {
  readonly deleteTranscript?: (sessionId: string) => undefined;
}

/** Who a purge is appended as, and in which transaction: a command's, or the sweep's own. */
export interface PurgeContext {
  readonly tx: Tx;
  /** As `kind:id` (`formatActor`): the client session of `sessions.purge`, or the sweep. */
  readonly actor: string;
  readonly commandId?: string;
}

export interface Deletion {
  /**
   * Purges one deleted session in the transaction `context` names, which
   * the caller holds open, and returns its tombstone. The caller has decided
   * the session may be purged.
   */
  purgeSession(sessionId: string, context: PurgeContext): EventEnvelope;
  /**
   * Purges every deleted session whose `purgeAt` is at or before `now`, each
   * in a transaction of its own, as the sweep; returns their ids, in the
   * order of their `purgeAt`. One that fails does not stop the others: they
   * are purged, then the failures are thrown together, naming each session.
   */
  purgeDue(now: Date): string[];
}

export interface DeletionOptions {
  readonly log: EventLog;
  /** Preset: an adapter that cannot delete a transcript. */
  readonly transcripts?: ProviderTranscripts;
}

/** The actor the sweep's purges are appended as. */
const SWEEP_ACTOR = formatActor(SYSTEM.sweep.actor);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether `value` is a promise, or anything else with a `then` to await. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";

export const createDeletion = (options: DeletionOptions): Deletion => {
  const { log } = options;
  const transcripts = options.transcripts ?? {};

  /**
   * What the purge does with the provider's transcript: what the delete
   * asked, and what the adapter can do. An adapter that answers with a
   * promise fails the purge rather than being recorded as done.
   */
  const providerTranscript = (sessionId: string, asked: boolean): ProviderTranscriptOutcome => {
    if (!asked) return { outcome: "kept" };
    if (transcripts.deleteTranscript === undefined) return { outcome: "unsupported" };
    let answered: unknown;
    try {
      answered = transcripts.deleteTranscript(sessionId);
    } catch (error) {
      return { outcome: "failed", message: messageOf(error) };
    }
    if (isThenable(answered)) {
      // Its outcome is unknowable here; a rejection is not left unhandled.
      Promise.resolve(answered).catch(() => undefined);
      throw new Error(`The adapter's transcript delete for session ${sessionId} answered with a promise; it must answer at once.`);
    }
    return { outcome: "deleted" };
  };

  const purgeSession = (sessionId: string, context: PurgeContext): EventEnvelope => {
    const [row] = log.read<{ delete_provider_transcript: number }>(
      "SELECT delete_provider_transcript FROM sessions WHERE id = ? AND deleted_at IS NOT NULL",
      sessionId,
    );
    if (row === undefined) throw new Error(`The session ${sessionId} is not deleted, so it cannot be purged.`);
    const stream = sessionStream(sessionId);
    log.purgeStream(stream, { tx: context.tx });
    // The adapter last, since what it does cannot be undone: after it only the tombstone's append and its projection.
    const payload: SessionPurgedPayload = { providerTranscript: providerTranscript(sessionId, row.delete_provider_transcript === 1) };
    const { events } = log.append(stream, [{ type: "session.purged", payload }], {
      tx: context.tx,
      actor: context.actor,
      ...(context.commandId !== undefined && { commandId: context.commandId }),
    });
    return events[0] as EventEnvelope;
  };

  return {
    purgeSession,
    purgeDue(now) {
      const due = log.read<{ id: string }>(
        "SELECT id FROM sessions WHERE deleted_at IS NOT NULL AND purge_at <= ? ORDER BY purge_at, id",
        now.toISOString(),
      );
      const purged: string[] = [];
      const failed: string[] = [];
      const failures: unknown[] = [];
      for (const { id } of due) {
        try {
          log.atomically((tx) => purgeSession(id, { tx, actor: SWEEP_ACTOR }));
          purged.push(id);
        } catch (error) {
          failed.push(id);
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Purging ${failures.length} of ${due.length} sessions failed: ${failed.join(", ")}.`);
      }
      return purged;
    },
  };
};
