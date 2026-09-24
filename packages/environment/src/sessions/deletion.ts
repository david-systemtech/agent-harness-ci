import { SESSION_STREAM_KIND, type ProviderTranscriptOutcome, type SessionPurgedPayload } from "@agent-harness/contracts";
import { SYSTEM } from "../auth/access-log.js";
import { formatActor, type EventEnvelope, type EventLog, type StreamRef, type Tx } from "../event-log/event-log.js";

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
 * present only when the adapter declares it. It runs inside the purge's
 * transaction, so it answers at once; a throw is recorded in the tombstone
 * as `failed` with its message, and the session is purged all the same.
 */
export interface ProviderTranscripts {
  readonly deleteTranscript?: (sessionId: string) => void;
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
   * are purged, then the failures are thrown together.
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

const sessionStream = (id: string): StreamRef => ({ kind: SESSION_STREAM_KIND, id });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createDeletion = (options: DeletionOptions): Deletion => {
  const { log } = options;
  const transcripts = options.transcripts ?? {};

  /** What the purge does with the provider's transcript: what the delete asked, and what the adapter can do. */
  const providerTranscript = (sessionId: string, asked: boolean): ProviderTranscriptOutcome => {
    if (!asked) return { outcome: "kept" };
    if (transcripts.deleteTranscript === undefined) return { outcome: "unsupported" };
    try {
      transcripts.deleteTranscript(sessionId);
      return { outcome: "deleted" };
    } catch (error) {
      return { outcome: "failed", message: messageOf(error) };
    }
  };

  const purgeSession = (sessionId: string, context: PurgeContext): EventEnvelope => {
    const [row] = log.read<{ delete_provider_transcript: number }>(
      "SELECT delete_provider_transcript FROM sessions WHERE id = ? AND deleted_at IS NOT NULL",
      sessionId,
    );
    if (row === undefined) throw new Error(`The session ${sessionId} is not deleted, so it cannot be purged.`);
    const stream = sessionStream(sessionId);
    log.purgeStream(stream, { tx: context.tx });
    // Asked after the log's rows are gone and before the tombstone, so the tombstone records what it did.
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
      const failures: unknown[] = [];
      for (const { id } of due) {
        try {
          log.atomically((tx) => purgeSession(id, { tx, actor: SWEEP_ACTOR }));
          purged.push(id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `The sweep failed to purge ${failures.length} of ${due.length} sessions.`);
      return purged;
    },
  };
};
