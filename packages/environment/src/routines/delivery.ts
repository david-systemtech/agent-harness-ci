import {
  ENVIRONMENT_STREAM_KIND,
  MAX_DELIVERY_BODY,
  MAX_DELIVERY_SUMMARY,
  ROUTINE_STREAM_KIND,
  type DeliveredOutcome,
  type FiringFailureReason,
  type RoutineDeliveredPayload,
  type RoutineDeliveryAttemptedPayload,
  type RoutineEntry,
  type RoutineFiringEndedPayload,
  type RoutineSkippedPayload,
  type SkipReason,
} from "@agent-harness/contracts";
import type { EventEnvelope, EventLog, Tx } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { appendRoutineRecord, routineActor } from "./records.js";
import { deliveredOutcome, takes } from "./delivery-outcome.js";
import { deliverableEntry, sameTarget } from "./routine-store.js";

export { deliveredOutcome, takes } from "./delivery-outcome.js";

/**
 * Delivery targets (routines spec, "Delivery targets"; #525): once an
 * entry's end commits (a firing's `routine.firing-ended`, a skip's
 * `routine.skipped`), a log subscriber delivers its result, in a
 * transaction of its own caused by that end, to each of the entry's
 * targets that takes it. A firing's targets are the ones its
 * `routine.firing-started` recorded, a skip's its routine's at its record
 * (the routine store's).
 *
 * | entry | delivered as | to targets on |
 * |---|---|---|
 * | a `succeeded` firing | `succeeded` | `success`, `both` |
 * | a `failed` firing; a skip `pre-check-failed` or `cannot-start` | `failed` | `failure`, `both` |
 * | a `silent` or `cancelled` firing; a skip `no-change`, `missed` or `overlap` | nothing | none |
 *
 * A **client notice** is `routine.delivered` on the environment's stream,
 * which every connected client raises: one for the entry however many of
 * its client-notice targets take it, each of which records its one
 * attempt, delivered, as `routine.delivery-attempted`, so the history
 * lists it. A target the entry has a delivery to already is not delivered
 * to again. A webhook target's delivery is #529's.
 */

/** The body of a succeeded firing that said nothing, and its summary. */
const NO_FINAL_MESSAGE = "The firing finished without a final message.";

/** A failed firing's summary: its failure's reason, in words. */
const FIRING_FAILED: Readonly<Record<FiringFailureReason, string>> = {
  run_error: "The firing's run ended in an error.",
  timed_out: "The firing ran past its maximum duration, and its run was stopped.",
  restart: "A restart cut the firing's run.",
  drained: "A drain cut the firing's run, and nothing continued it.",
};

/** A failing skip's summary opens with its reason, in words; its detail follows. */
const SKIP_FAILED: Readonly<Partial<Record<SkipReason, string>>> = {
  "pre-check-failed": "The pre-check failed",
  "cannot-start": "The firing could not start",
};

/** The first line of `text` with anything on it, trimmed; null when it has none. */
const firstLine = (text: string): string | null =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;

/**
 * What a delivered result says: a summary (the text's first non-blank line,
 * or the failure's reason) and a body (the text, or the failure's detail),
 * each cut to its bound. A succeeded firing that said nothing says
 * `NO_FINAL_MESSAGE`; a failed firing that said nothing, its reason.
 */
export const deliveredResult = (entry: RoutineEntry, outcome: DeliveredOutcome): { readonly summary: string; readonly body: string } => {
  const cut = (summary: string, body: string) => ({ summary: summary.slice(0, MAX_DELIVERY_SUMMARY), body: body.slice(0, MAX_DELIVERY_BODY) });
  if (entry.kind === "skip") {
    const lead = SKIP_FAILED[entry.reason] ?? entry.reason;
    const detail = entry.detail ?? "";
    const line = firstLine(detail);
    return line === null ? cut(`${lead}.`, `${lead}.`) : cut(`${lead}: ${line}`, detail);
  }
  const text = entry.text ?? "";
  const line = firstLine(text);
  if (outcome === "succeeded") return line === null ? cut(NO_FINAL_MESSAGE, NO_FINAL_MESSAGE) : cut(line, text);
  const reason = FIRING_FAILED[entry.reason ?? "run_error"];
  return cut(reason, line === null ? reason : text);
};

/** The ended entry an event records: a firing's end, or a skip; null for any other event. */
export const endedEntryOf = (event: EventEnvelope): string | null => {
  if (event.streamKind !== ROUTINE_STREAM_KIND) return null;
  if (event.type === "routine.firing-ended") return (event.payload as RoutineFiringEndedPayload).firingId;
  if (event.type === "routine.skipped") return (event.payload as RoutineSkippedPayload).skipId;
  return null;
};

export interface DeliveriesOptions {
  readonly log: EventLog;
  /** The environment's clock, which stamps the deliveries. */
  readonly clock: () => Date;
  /** The environment's id: its stream carries `routine.delivered`. */
  readonly environmentId: string;
}

/**
 * Follows every entry's end, delivering its result to the client-notice
 * targets that take it once the end has committed, in a transaction of its
 * own caused by it, as the routine. Subscribed before the adapter host
 * starts and closed after the firings' ends are, so an end the recovery
 * sweep or the host's close makes is delivered too. Answers the
 * unsubscribe.
 */
const noticeDelivery = ({ log, clock, environmentId }: DeliveriesOptions) => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** Delivers the entry's result to the client-notice targets it owes, in the open transaction. */
  const deliver = (tx: Tx, routineId: string, entryId: string, cause: EventEnvelope): void => {
    const deliverable = deliverableEntry(reader, routineId, entryId);
    if (deliverable === null) return;
    const { entry, name } = deliverable;
    const outcome = deliveredOutcome(entry);
    if (outcome === null) return;
    // Each client-notice target that takes the result, once however often the routine names it, and not delivered to already.
    const owed = deliverable.targets.filter(
      (target, index, targets) =>
        target.kind === "client-notice" &&
        takes(target.on, outcome) &&
        targets.findIndex((other) => sameTarget(other, target)) === index &&
        !entry.deliveries.some((delivery) => sameTarget(delivery.target, target)),
    );
    if (owed.length === 0) return;
    const at = clock().toISOString();
    const attribution = { tx, actor: routineActor(routineId), causationId: cause.eventId, correlationId: entryId };
    for (const target of owed) {
      const payload: RoutineDeliveryAttemptedPayload = { entryId, target, attempt: 1, result: "delivered", status: null, error: null, retryAt: null };
      appendRoutineRecord(log, environmentId, routineId, { event: { type: "routine.delivery-attempted", payload, occurredAt: at }, change: "delivery-attempted" }, attribution);
    }
    const payload: RoutineDeliveredPayload = {
      routineId,
      name,
      entryId,
      entryKind: entry.kind,
      sessionId: entry.kind === "firing" ? entry.sessionId : null,
      outcome,
      ...deliveredResult(entry, outcome),
    };
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "routine.delivered", payload, occurredAt: at }], attribution);
  };

  return deliver;
};

export const followDeliveries = (options: DeliveriesOptions): (() => void) => {
  const deliver = noticeDelivery(options);
  return options.log.subscribe((event) => {
    const entryId = endedEntryOf(event);
    if (entryId === null) return;
    try {
      options.log.atomically((tx) => deliver(tx, event.streamId, entryId, event));
    } catch (error) {
      console.error(`Delivering the entry ${entryId} of the routine ${event.streamId} failed:`, error);
    }
  });
};

/** The start pass resumes notices lost between an entry's end and its delivery commit. */
export const resumeDeliveries = (options: DeliveriesOptions): void => {
  const { log } = options;
  const deliver = noticeDelivery(options);
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const ended = log.read<{ routine_id: string; id: string; cause_sequence: number }>("SELECT routine_id, id, cause_sequence FROM routine_pending_notices ORDER BY cause_sequence");
  for (const { routine_id: routineId, id, cause_sequence: sequence } of ended) {
    const entry = deliverableEntry(reader, routineId, id);
    if (entry === null) continue;
    const outcome = deliveredOutcome(entry.entry);
    if (outcome === null || !entry.targets.some((target) => target.kind === "client-notice" && takes(target.on, outcome) && !entry.entry.deliveries.some((delivery) => sameTarget(delivery.target, target)))) continue;
    const cause = log.readStream({ kind: ROUTINE_STREAM_KIND, id: routineId }, sequence - 1, 1).find((event) => endedEntryOf(event) === id);
    if (cause === undefined) continue;
    try {
      log.atomically((tx) => deliver(tx, routineId, id, cause));
    } catch (error) {
      console.error(`Resuming the delivery of entry ${id} of routine ${routineId} failed; the next start retries it:`, error);
    }
  }
};
