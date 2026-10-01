import { RunEndedPayload, SESSION_STREAM_KIND } from "@agent-harness/contracts";
import type { EventEnvelope } from "../event-log/envelope.js";
import type { Reader } from "../sessions/session-reads.js";

/**
 * Minted sessions as Set up reads them (ADR 0019; the Set up
 * specification, "The LLM step and minted sessions"; #584): a session
 * tagged `setup` and a step's id, as `setup.mint` tags the sessions it
 * mints and as anyone may tag one by hand. A run end of one checks that
 * step again (`scheduler.ts`), and an LLM step's check reads how the
 * latest of them last ended (`check.ts`).
 */

/** The tag every minted session carries, beside its step's id. */
export const SETUP_TAG = "setup";

/** How a minted session's last run ended other than cleanly: with an error, its message; stopped, none. */
export interface StoppedRun {
  readonly sessionId: string;
  /** The session's title, as a result's target names it. */
  readonly title: string;
  /** The error it ended with; null for a run that was stopped (interrupted, drained or let go). */
  readonly error: string | null;
}

/** The tags, in lowercase, of the session whose run `event` ended, when it is a minted session; none for any other event. */
export const mintedRunEnd = (reader: Reader, event: EventEnvelope): ReadonlySet<string> => {
  if (event.type !== "run.ended" || event.streamKind !== SESSION_STREAM_KIND) return new Set();
  const tags = new Set(reader.all<{ tag_key: string }>("SELECT tag_key FROM session_tags WHERE session_id = ?", event.streamId).map((row) => row.tag_key));
  return tags.has(SETUP_TAG) ? tags : new Set();
};

/** The error message a run's `run.ended` recorded, when the log still holds it. */
const errorOf = (reader: Reader, sessionId: string, runId: string): string | null => {
  const [row] = reader.all<{ payload: string }>(
    "SELECT payload FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'run.ended' AND json_extract(payload, '$.runId') = ? ORDER BY sequence DESC LIMIT 1",
    SESSION_STREAM_KIND,
    sessionId,
    runId,
  );
  const ended = row === undefined ? undefined : RunEndedPayload.safeParse(JSON.parse(row.payload));
  return ended?.success === true ? (ended.data.error?.message ?? null) : null;
};

/**
 * The last run of `step`'s latest minted session, the one created last that
 * is not deleted, when it ended other than completed: an error, with its
 * message ("The run ended with an error." when the log no longer holds
 * it), or stopped. Null while no minted session has a run, while its run is
 * live, and after a clean end.
 */
export const stoppedMintedRun = (reader: Reader, step: string): StoppedRun | null => {
  const [session] = reader.all<{ id: string; title: string }>(
    `SELECT s.id, s.title FROM sessions s
       JOIN session_tags setup ON setup.session_id = s.id AND setup.tag_key = ?
       JOIN session_tags step ON step.session_id = s.id AND step.tag_key = ?
     WHERE s.deleted_at IS NULL
     ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
    SETUP_TAG,
    step,
  );
  if (session === undefined) return null;
  const [run] = reader.all<{ run_id: string; state: string; reason: string | null }>(
    "SELECT run_id, state, reason FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    session.id,
  );
  if (run === undefined || run.state !== "ended" || run.reason === "completed") return null;
  const error = run.reason === "error" ? (errorOf(reader, session.id, run.run_id) ?? "The run ended with an error.") : null;
  return { sessionId: session.id, title: session.title, error };
};
