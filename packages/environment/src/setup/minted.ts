import { RunEndedPayload, SESSION_STREAM_KIND, SetupMintedPayload } from "@agent-harness/contracts";
import type { EventEnvelope } from "../event-log/envelope.js";
import type { Reader } from "../sessions/session-reads.js";
import type { StepSubject } from "./mint.js";

/**
 * Minted sessions as Set up reads them (ADR 0019; the Set up
 * specification, "The LLM step and minted sessions"; #584): a session
 * tagged `setup` and a step's id, as `setup.mint` tags the sessions it
 * mints and as anyone may tag one by hand. A run end of one checks that
 * step again (`scheduler.ts`), and an LLM step's check reads how the
 * latest of them per subject last ended (`check.ts`).
 */

/** The tag every minted session carries, beside its step's id. */
export const SETUP_TAG = "setup";

/** How a minted session's last run ended other than cleanly: with an error, its message; stopped, none. */
export interface StoppedRun {
  readonly sessionId: string;
  /** The session's title, as a result's target names it. */
  readonly title: string;
  /** The recorded subject; null for a subjectless mint or a session tagged by hand or minted before provenance was recorded. */
  readonly subject: StepSubject | null;
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
 * Each subject's latest undeleted minted session, when its last run failed
 * or stopped. A newer draft, live run or clean end supersedes older runs
 * only for its own subject. Sessions without recorded provenance share a
 * subjectless bucket, retaining the pre-provenance behaviour without
 * guessing a subject from a title or workspace.
 */
export const stoppedMintedRuns = (reader: Reader, step: string): StoppedRun[] => {
  const sessions = reader.all<{ id: string; title: string; minted: string | null }>(
    `SELECT s.id, s.title, m.payload AS minted FROM sessions s
       JOIN session_tags setup ON setup.session_id = s.id AND setup.tag_key = ?
       JOIN session_tags step ON step.session_id = s.id AND step.tag_key = ?
       LEFT JOIN events m ON m.stream_kind = ? AND m.stream_id = s.id
         AND m.type = 'setup.minted' AND json_extract(m.payload, '$.step') = ?
     WHERE s.deleted_at IS NULL
     ORDER BY s.created_at DESC, s.rowid DESC`,
    SETUP_TAG,
    step,
    SESSION_STREAM_KIND,
    step,
  );
  const seen = new Set<string>();
  const stopped: StoppedRun[] = [];
  for (const session of sessions) {
    const minted = session.minted === null ? undefined : SetupMintedPayload.safeParse(JSON.parse(session.minted));
    const subject = minted?.success === true ? minted.data.subject : null;
    const key = JSON.stringify(subject === null ? null : [subject.kind, subject.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const [run] = reader.all<{ run_id: string; state: string; reason: string | null }>(
      "SELECT run_id, state, reason FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      session.id,
    );
    if (run === undefined || run.state !== "ended" || run.reason === "completed") continue;
    const error = run.reason === "error" ? (errorOf(reader, session.id, run.run_id) ?? "The run ended with an error.") : null;
    stopped.push({ sessionId: session.id, title: session.title, subject, error });
  }
  return stopped;
};
