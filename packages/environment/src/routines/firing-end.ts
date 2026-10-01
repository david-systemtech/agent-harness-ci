import {
  isSilent,
  MAX_ROUTINE_TEXT,
  SESSION_STREAM_KIND,
  type FiringFailureReason,
  type FiringOutcome,
  type ModelUsage,
  type RoutineFiringEndedPayload,
  type RunEndedPayload,
} from "@agent-harness/contracts";
import type { AppendOptions, EventLog, Tx } from "../event-log/event-log.js";
import { appendDecided } from "../sessions/companions.js";
import { stampedAt } from "../sessions/decider.js";
import { readSessionState, type Reader } from "../sessions/session-reads.js";
import { decideSettle } from "../sessions/shelf-decider.js";
import { sessionStream } from "../sessions/streams.js";
import { appendRoutineRecord, routineActor } from "./records.js";
import { liveFiringOfRun, type LiveFiringRecord } from "./routine-store.js";

/**
 * How a firing ends (routines spec, "A firing": End; #523): a log
 * subscriber reads it from its run's `run.ended` and appends
 * `routine.firing-ended` as the routine, caused by that end, with the
 * outcome and a failure's reason, the final text, the usage and the
 * duration. Only a live firing's run is followed: a run a person starts in
 * the firing's session is theirs, and a firing its routine's deletion ended
 * (`routines.delete`) is over whatever its run does after.
 *
 * | `run.ended` | outcome |
 * |---|---|
 * | `completed`, its final text silent for the firing's marker | `silent` |
 * | `completed`, otherwise | `succeeded`, empty text too |
 * | `error` | `failed`, `run_error` |
 * | interrupted by a person (`user`, `read-now`) | `cancelled` |
 * | interrupted, cause `timeout` | `failed`, `timed_out` |
 * | interrupted by a restart, or its process let go while parked | `failed`, `restart` |
 * | `disposed`, its session deleted | `cancelled` |
 * | `disposed`, otherwise | `failed`, `restart` |
 * | `drained` | `failed`, `drained` |
 *
 * A silent firing (the silence rule, `isSilent`, over its whole final text
 * and the marker it started with; #524) delivers nothing, and the
 * transaction that ends it also settles its session, `settledBy`
 * `routine`, so the session leaves the active list. A drained firing's wait
 * for its continuation is #535's.
 */

/** How a firing ended, and why when it failed. */
export interface FiringEnd {
  readonly outcome: FiringOutcome;
  readonly reason: FiringFailureReason | null;
}

const failed = (reason: FiringFailureReason): FiringEnd => ({ outcome: "failed", reason });

/** What a firing's end turns on besides its run's: whether its session was deleted by then, and whether its final text is silent. */
export interface FiringEndFacts {
  readonly sessionDeleted: boolean;
  readonly silent: boolean;
}

/** The outcomes whose pre-check output becomes the baseline. */
const ADVANCING: ReadonlySet<FiringOutcome> = new Set(["succeeded", "silent"]);
const cancelled: FiringEnd = { outcome: "cancelled", reason: null };

/** The firing's end, from how its run ended, whether its session was deleted by then and whether its final text is silent. */
export const firingEndOf = (ended: Pick<RunEndedPayload, "reason" | "cause">, { sessionDeleted, silent }: FiringEndFacts): FiringEnd => {
  switch (ended.reason) {
    case "completed":
      return { outcome: silent ? "silent" : "succeeded", reason: null };
    case "error":
      return failed("run_error");
    case "disposed":
      return sessionDeleted ? cancelled : failed("restart");
    case "drained":
      return failed("drained");
    case "interrupted":
      switch (ended.cause) {
        case "user":
        case "read-now":
          return cancelled;
        case "timeout":
          return failed("timed_out");
        case "restart":
        case "parked":
        case null:
          return failed("restart");
      }
  }
};

/** The run's last assistant text; null when it said nothing. */
const lastAssistantText = (reader: Reader, sessionId: string, runId: string): string | null =>
  reader.all<{ text: string }>(
    `SELECT json_extract(payload, '$.text') AS text FROM events
     WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'assistant.text' AND json_extract(payload, '$.runId') = ?
     ORDER BY sequence DESC LIMIT 1`,
    sessionId,
    runId,
  )[0]?.text ?? null;

/** A firing's final text: its run's result text, else its last assistant text; empty when it had neither. */
const finalText = (reader: Reader, firing: LiveFiringRecord, resultText: string | null): string =>
  resultText !== null && resultText !== "" ? resultText : (lastAssistantText(reader, firing.entry.sessionId, firing.entry.runId) ?? "");

/** A firing's final text as its end records it: at most 16,000 characters. */
export const firingText = (reader: Reader, firing: LiveFiringRecord, resultText: string | null): string => finalText(reader, firing, resultText).slice(0, MAX_ROUTINE_TEXT);

/** Whether the session is deleted, or purged since. */
const sessionDeleted = (reader: Reader, sessionId: string): boolean => {
  const [row] = reader.all<{ deleted_at: string | null }>("SELECT deleted_at FROM sessions WHERE id = ?", sessionId);
  return row === undefined || row.deleted_at !== null;
};

/**
 * Ends `firing` in the open transaction: `routine.firing-ended` on its
 * routine's stream as the routine, at `at`, with `end`, its text, its usage
 * and its duration from its start. Its pre-check's output becomes the
 * baseline when it ended `succeeded` or `silent` (#526); a firing that ran
 * no pre-check, or failed, leaves the baseline where it was, so the next
 * due time fires again. Its notice follows.
 */
export const endFiring = (
  log: EventLog,
  environmentId: string,
  firing: LiveFiringRecord,
  ended: FiringEnd & { readonly text: string; readonly usage: readonly ModelUsage[] | null },
  at: string,
  attribution: Omit<AppendOptions, "actor"> & { readonly tx: Tx },
): void => {
  const payload: RoutineFiringEndedPayload = {
    firingId: firing.entry.id,
    outcome: ended.outcome,
    reason: ended.reason,
    text: ended.text,
    usage: ended.usage === null ? null : [...ended.usage],
    durationMs: Math.max(0, Date.parse(at) - Date.parse(firing.entry.startedAt)),
    baselineAdvanced: ADVANCING.has(ended.outcome) && (firing.entry.preCheck?.hash ?? null) !== null,
  };
  appendRoutineRecord(log, environmentId, firing.routineId, { event: { type: "routine.firing-ended", payload, occurredAt: at }, change: "firing-ended" }, {
    ...attribution,
    actor: routineActor(firing.routineId),
  });
};

export interface FiringEndsOptions {
  readonly log: EventLog;
  /** The environment's clock, which stamps the end. */
  readonly clock: () => Date;
  /** The environment's id: its stream carries the `routine.updated` notices. */
  readonly environmentId: string;
}

/**
 * Settles a silent firing's session in the open transaction, at `at`, as
 * the routine, `settledBy` `routine`, with the settle's companions; a
 * session settled already is left as it is, and one deleted meanwhile has
 * nothing to settle.
 */
const settleSession = (log: EventLog, reader: Reader, sessionId: string, at: string, attribution: AppendOptions & { readonly tx: Tx }): void => {
  const decision = stampedAt(decideSettle(readSessionState(reader, sessionId), { sessionId, at, by: "routine" }), at);
  if (decision.rejected !== undefined) return;
  appendDecided(log, sessionStream(sessionId), decision, attribution);
};

/**
 * Follows every run's end, ending the live firing whose run it is, once
 * its `run.ended` has committed, in a transaction of its own caused by it;
 * a silent firing's session is settled in the same transaction.
 * Subscribed before the adapter host starts, so it hears the recovery
 * sweep's end of a run a crash cut, and the host's ends as the environment
 * closes. Answers the unsubscribe.
 */
export const followFiringEnds = ({ log, clock, environmentId }: FiringEndsOptions): (() => void) => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  return log.subscribe((event) => {
    if (event.streamKind !== SESSION_STREAM_KIND || event.type !== "run.ended") return;
    const ended = event.payload as RunEndedPayload;
    const firing = liveFiringOfRun(reader, ended.runId);
    if (firing === null) return;
    try {
      const text = finalText(reader, firing, ended.resultText);
      const end = firingEndOf(ended, { sessionDeleted: sessionDeleted(reader, firing.entry.sessionId), silent: isSilent(text, firing.silenceMarker) });
      const at = clock().toISOString();
      log.atomically((tx) => {
        const attribution = { tx, causationId: event.eventId, correlationId: ended.runId };
        endFiring(log, environmentId, firing, { ...end, text: text.slice(0, MAX_ROUTINE_TEXT), usage: ended.usage }, at, attribution);
        if (end.outcome === "silent") settleSession(log, reader, firing.entry.sessionId, at, { ...attribution, actor: routineActor(firing.routineId) });
      });
    } catch (error) {
      console.error(`Ending the firing ${firing.entry.id} of the routine ${firing.routineId} failed; it stays live:`, error);
    }
  });
};
