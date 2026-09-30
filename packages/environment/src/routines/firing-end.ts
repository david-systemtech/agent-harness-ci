import {
  MAX_ROUTINE_TEXT,
  SESSION_STREAM_KIND,
  type FiringFailureReason,
  type FiringOutcome,
  type ModelUsage,
  type RoutineFiringEndedPayload,
  type RunEndedPayload,
} from "@agent-harness/contracts";
import type { AppendOptions, EventLog, Tx } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
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
 * | `completed` | `succeeded`, empty text too |
 * | `error` | `failed`, `run_error` |
 * | interrupted by a person (`user`, `read-now`) | `cancelled` |
 * | interrupted, cause `timeout` | `failed`, `timed_out` |
 * | interrupted by a restart, or its process let go while parked | `failed`, `restart` |
 * | `disposed`, its session deleted | `cancelled` |
 * | `disposed`, otherwise | `failed`, `restart` |
 * | `drained` | `failed`, `drained` |
 *
 * The silence rule's `silent` is #524's, and a drained firing's wait for
 * its continuation #535's.
 */

/** How a firing ended, and why when it failed. */
export interface FiringEnd {
  readonly outcome: FiringOutcome;
  readonly reason: FiringFailureReason | null;
}

const failed = (reason: FiringFailureReason): FiringEnd => ({ outcome: "failed", reason });
const cancelled: FiringEnd = { outcome: "cancelled", reason: null };

/** The firing's end, from how its run ended and whether its session was deleted by then. */
export const firingEndOf = (ended: Pick<RunEndedPayload, "reason" | "cause">, sessionDeleted: boolean): FiringEnd => {
  switch (ended.reason) {
    case "completed":
      return { outcome: "succeeded", reason: null };
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

/**
 * A firing's final text: its run's result text, else its last assistant
 * text, at most 16,000 characters; empty when it had neither.
 */
export const firingText = (reader: Reader, firing: LiveFiringRecord, resultText: string | null): string => {
  const text = resultText !== null && resultText !== "" ? resultText : (lastAssistantText(reader, firing.entry.sessionId, firing.entry.runId) ?? "");
  return text.slice(0, MAX_ROUTINE_TEXT);
};

/** Whether the session is deleted, or purged since. */
const sessionDeleted = (reader: Reader, sessionId: string): boolean => {
  const [row] = reader.all<{ deleted_at: string | null }>("SELECT deleted_at FROM sessions WHERE id = ?", sessionId);
  return row === undefined || row.deleted_at !== null;
};

/**
 * Ends `firing` in the open transaction: `routine.firing-ended` on its
 * routine's stream as the routine, at `at`, with `end`, its text, its usage
 * and its duration from its start; no pre-check ran, so the baseline stays
 * where it was. Its notice follows.
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
    baselineAdvanced: false,
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
 * Follows every run's end, ending the live firing whose run it is, once
 * its `run.ended` has committed, in a transaction of its own caused by it.
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
      const end = firingEndOf(ended, sessionDeleted(reader, firing.entry.sessionId));
      log.atomically((tx) =>
        endFiring(log, environmentId, firing, { ...end, text: firingText(reader, firing, ended.resultText), usage: ended.usage }, clock().toISOString(), {
          tx,
          causationId: event.eventId,
          correlationId: ended.runId,
        }),
      );
    } catch (error) {
      console.error(`Ending the firing ${firing.entry.id} of the routine ${firing.routineId} failed; it stays live:`, error);
    }
  });
};
