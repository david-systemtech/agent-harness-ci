import {
  ENVIRONMENT_STREAM_KIND, MAX_ROUTINE_TEXT, ROUTINE_STREAM_KIND, ROUTINE_WEBHOOK_VERSION,
  type DeliveryTarget, type RoutineCreatedPayload, type RoutineEditedPayload, type RoutineFiringStartedPayload,
  type RoutineFiringEndedPayload, type RoutineSkippedPayload, type RoutineDeliveryAttemptedPayload, type RoutineDeliveryFailedPayload, type WebhookPayload,
} from "@agent-harness/contracts";
import type { Reader } from "../sessions/session-reads.js";
import type { EventLog, Projector, ProjectionDb } from "../event-log/event-log.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import { deliveredOutcome, deliveredResult, endedEntryOf, takes } from "./delivery.js";
import { appendRoutineRecord, routineActor } from "./records.js";
import { deliverableEntry, sameTarget, type DeliverableEntry } from "./routine-store.js";
import { postWebhook, networkReason } from "./webhook-post.js";

/** A resolved endpoint, or why it cannot be used. References that cannot be resolved retry (#536). */
export type DeliveryEndpoint =
  | { readonly url: string; readonly secret: string; readonly release?: ScrubRelease }
  | { readonly error: string; readonly retryable: boolean };

export interface WebhookDeliveriesOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  readonly name: () => string;
  /** The endpoint and its secret as held now, resolved afresh for each attempt. */
  readonly endpoint: (name: string) => Promise<DeliveryEndpoint>;
  readonly scrub: Pick<ScrubRegistry, "scrubOutput">;
}

type WebhookTarget = Extract<DeliveryTarget, { kind: "webhook" }>;
const RETRY_DELAYS = [60_000, 300_000, 1_800_000] as const;

/** Owns the owed targets, independently of routine history, so replay also reconstructs lost first attempts. */
const pendingWebhooksProjector: Projector = {
  name: "routine-webhook-deliveries",
  tables: {
    routine_webhook_definitions: `CREATE TABLE routine_webhook_definitions (
      routine_id TEXT PRIMARY KEY,
      targets TEXT NOT NULL
    ) STRICT`,
    routine_webhook_pending: `CREATE TABLE routine_webhook_pending (
      entry_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      delivery_on TEXT NOT NULL,
      ready INTEGER NOT NULL,
      retry_at TEXT,
      PRIMARY KEY (entry_id, endpoint, delivery_on)
    ) STRICT;
    CREATE INDEX routine_webhook_ready ON routine_webhook_pending (entry_id, routine_id) WHERE ready = 1`,
  },
  apply(event, db) {
    if (event.streamKind !== ROUTINE_STREAM_KIND) return;
    switch (event.type) {
      case "routine.created": {
        const { definition } = event.payload as RoutineCreatedPayload;
        db.run("INSERT INTO routine_webhook_definitions (routine_id, targets) VALUES (?, ?)", event.streamId, JSON.stringify(definition.delivery));
        break;
      }
      case "routine.edited": {
        const { fields } = event.payload as RoutineEditedPayload;
        if (fields.delivery !== undefined) db.run("UPDATE routine_webhook_definitions SET targets = ? WHERE routine_id = ?", JSON.stringify(fields.delivery), event.streamId);
        break;
      }
      case "routine.deleted":
        db.run("DELETE FROM routine_webhook_definitions WHERE routine_id = ?", event.streamId);
        break;
      case "routine.firing-started": {
        const { firingId, targets } = event.payload as RoutineFiringStartedPayload;
        oweWebhooks(db, event.streamId, firingId, targets, false);
        break;
      }
      case "routine.firing-ended": {
        const { firingId, outcome } = event.payload as RoutineFiringEndedPayload;
        if (outcome !== "succeeded" && outcome !== "failed") {
          db.run("DELETE FROM routine_webhook_pending WHERE entry_id = ?", firingId);
        } else {
          const on = outcome === "succeeded" ? "success" : "failure";
          db.run("DELETE FROM routine_webhook_pending WHERE entry_id = ? AND delivery_on NOT IN ('both', ?)", firingId, on);
          db.run("UPDATE routine_webhook_pending SET ready = 1 WHERE entry_id = ?", firingId);
        }
        break;
      }
      case "routine.skipped": {
        const { skipId, reason } = event.payload as RoutineSkippedPayload;
        if (reason !== "cannot-start" && reason !== "pre-check-failed") break;
        const row = db.get<{ targets: string }>("SELECT targets FROM routine_webhook_definitions WHERE routine_id = ?", event.streamId);
        const targets = row === undefined ? [] : JSON.parse(row.targets) as DeliveryTarget[];
        oweWebhooks(db, event.streamId, skipId, targets.filter((target) => takes(target.on, "failed")), true);
        break;
      }
      case "routine.delivery-attempted": {
        const { entryId, target, result, retryAt } = event.payload as RoutineDeliveryAttemptedPayload;
        if (target.kind !== "webhook") break;
        if (result === "retrying") {
          db.run("UPDATE routine_webhook_pending SET retry_at = ? WHERE entry_id = ? AND endpoint = ? AND delivery_on = ?", retryAt, entryId, target.target, target.on);
        } else {
          db.run("DELETE FROM routine_webhook_pending WHERE entry_id = ? AND endpoint = ? AND delivery_on = ?", entryId, target.target, target.on);
        }
        break;
      }
    }
  },
};

const oweWebhooks = (db: ProjectionDb, routineId: string, entryId: string, targets: readonly DeliveryTarget[], ready: boolean): void => {
  for (const target of targets) {
    if (target.kind !== "webhook") continue;
    db.run("INSERT OR IGNORE INTO routine_webhook_pending (entry_id, routine_id, endpoint, delivery_on, ready) VALUES (?, ?, ?, ?, ?)", entryId, routineId, target.target, target.on, ready ? 1 : 0);
  }
};

/** Captured targets remain owed while a firing runs or its delivery awaits an attempt. */
export const hasPendingWebhookDelivery = (reader: Reader, endpoint: string): boolean =>
  reader.all("SELECT 1 FROM routine_webhook_pending WHERE endpoint = ? LIMIT 1", endpoint).length > 0;

/** The result's JSON; the summary shares the client notice's words, but the text keeps all 16,000 characters. */
const payloadOf = (routineId: string, { entry, name }: DeliverableEntry, options: WebhookDeliveriesOptions): WebhookPayload | null => {
  const outcome = deliveredOutcome(entry);
  if (outcome === null) return null;
  if (entry.kind === "firing" && entry.endedAt === null) return null;
  const at = entry.kind === "skip" ? entry.at : entry.startedAt;
  return {
    type: "routine.result", version: ROUTINE_WEBHOOK_VERSION,
    environment: { id: options.environmentId, name: options.name() }, routine: { id: routineId, name },
    entry: {
      id: entry.id, kind: entry.kind, trigger: entry.trigger, dueAt: entry.dueAt,
      startedAt: at, endedAt: entry.kind === "skip" ? at : entry.endedAt!, outcome,
      reason: entry.kind === "skip" ? (entry.reason === "cannot-start" ? "cannot-start" : "pre-check-failed") : entry.reason,
      sessionId: entry.kind === "skip" ? null : entry.sessionId,
    },
    summary: deliveredResult(entry, outcome).summary,
    text: (entry.kind === "skip" ? (entry.detail ?? "") : (entry.text ?? "")).slice(0, MAX_ROUTINE_TEXT),
  };
};

/**
 * Follows committed entry ends without delaying the firing. The projected attempts are the queue:
 * a start also finds results whose end committed before a crash, and resumes pending retries at
 * retryAt (or immediately if overdue). Retrying attempts emit no routine.updated; a delivered
 * result refreshes clients. An interrupted POST is left owed and may be sent again with the
 * same webhook-id, for the receiver to deduplicate.
 */
export const createWebhookDeliveries = (options: WebhookDeliveriesOptions) => {
  const { log, clock, environmentId } = options;
  log.registerProjector(pendingWebhooksProjector);
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  let started = false;
  let closed = false;
  const scheduled = new Map<string, Timer>();
  const running = new Map<string, Promise<void>>();
  const abort = new AbortController();

  const keyOf = (entryId: string, target: WebhookTarget) => `${entryId}:${target.target}:${target.on}`;
  const attempt = async (routineId: string, entryId: string, target: WebhookTarget): Promise<void> => {
    const held = deliverableEntry(reader, routineId, entryId);
    if (held === null) return;
    const payload = payloadOf(routineId, held, options);
    if (payload === null) return;
    const previous = held.entry.deliveries.find((delivery) => sameTarget(delivery.target, target));
    if (previous !== undefined && previous.result !== "pending") return;
    const number = (previous?.attempts.at(-1)?.attempt ?? 0) + 1;
    let status: number | null = null;
    let error: string | null;
    let retryable: boolean;
    let endpoint: DeliveryEndpoint;
    try {
      endpoint = await options.endpoint(target.target);
    } catch (caught) {
      endpoint = { error: `The endpoint's secret could not be resolved: ${networkReason(caught)}.`, retryable: true };
    }
    try {
      if (closed) return;
      if ("error" in endpoint) {
        error = endpoint.error;
        retryable = endpoint.retryable;
      } else {
        try {
          const posted = await postWebhook({ ...endpoint, id: keyOf(entryId, target), body: JSON.stringify(payload), clock, signal: abort.signal });
          status = posted.status;
          error = posted.error;
          retryable = status === null || status === 408 || status === 429 || status >= 500;
        } catch (caught) {
          error = `The webhook POST could not be prepared: ${networkReason(caught)}.`;
          retryable = false;
        }
      }
      if (closed) return;
      error = error === null ? null : options.scrub.scrubOutput(error);
      const at = clock.now().toISOString();
      const delay = error !== null && retryable ? RETRY_DELAYS[number - 1] : undefined;
      const retryAt = delay === undefined ? null : new Date(clock.now().getTime() + delay).toISOString();
      const result = error === null ? "delivered" : retryAt === null ? "failed" : "retrying";
      log.atomically((tx) => {
        const attribution = { tx, actor: routineActor(routineId), correlationId: entryId };
        const made: RoutineDeliveryAttemptedPayload = { entryId, target, attempt: number, result, status, error, retryAt };
        const record = appendRoutineRecord(log, environmentId, routineId, { event: { type: "routine.delivery-attempted", payload: made, occurredAt: at }, change: result === "delivered" ? "delivery-attempted" : null }, attribution);
        if (result === "failed") {
          const failed: RoutineDeliveryFailedPayload = { routineId, name: held.name, entryId, endpoint: target.target, error: error! };
          log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "routine.delivery-failed", payload: failed, occurredAt: at }], { ...attribution, causationId: record.eventId });
        }
      });
    } finally {
      if (!("error" in endpoint)) endpoint.release?.();
    }
  };

  const launch = (routineId: string, entryId: string, target: WebhookTarget): void => {
    const key = keyOf(entryId, target);
    if (closed || running.has(key)) return;
    const work = attempt(routineId, entryId, target).then(
      () => { running.delete(key); if (!closed) enqueue(routineId, entryId); },
      (error: unknown) => {
        running.delete(key);
        // A failed log write leaves the result owed for the next start; never spin on a broken log.
        console.error(`Delivering the entry ${entryId} of routine ${routineId} failed: ${options.scrub.scrubOutput(networkReason(error))}`);
      },
    );
    running.set(key, work);
  };

  const enqueue = (routineId: string, entryId: string): void => {
    if (!started || closed) return;
    try {
      const held = deliverableEntry(reader, routineId, entryId);
      if (held === null) return;
      const outcome = deliveredOutcome(held.entry);
      if (outcome === null) return;
      for (const [index, target] of held.targets.entries()) {
        if (target.kind !== "webhook" || !takes(target.on, outcome) || held.targets.findIndex((other) => sameTarget(other, target)) !== index) continue;
        const key = keyOf(entryId, target);
        if (running.has(key) || scheduled.has(key)) continue;
        const delivery = held.entry.deliveries.find((other) => sameTarget(other.target, target));
        if (delivery !== undefined && delivery.result !== "pending") continue;
        const retryAt = delivery?.attempts.at(-1)?.retryAt;
        const delay = retryAt == null ? 0 : Date.parse(retryAt) - clock.now().getTime();
        if (delay <= 0) launch(routineId, entryId, target);
        else scheduled.set(key, clock.setTimeout(() => { scheduled.delete(key); launch(routineId, entryId, target); }, delay));
      }
    } catch (error) {
      // No queue state is acknowledged on failure: the committed projection still owes it.
      console.error(`Queuing the entry ${entryId} of routine ${routineId} failed: ${options.scrub.scrubOutput(networkReason(error))}`);
    }
  };

  const unsubscribe = log.subscribe((event) => {
    const entryId = endedEntryOf(event);
    if (entryId !== null) enqueue(event.streamId, entryId);
  });
  return {
    start(): void {
      if (started || closed) return;
      started = true;
      try {
        for (const row of log.read<{ routine_id: string; id: string }>("SELECT DISTINCT routine_id, entry_id AS id FROM routine_webhook_pending WHERE ready = 1")) enqueue(row.routine_id, row.id);
      } catch (error) {
        console.error(`Reading pending webhook deliveries at startup failed: ${options.scrub.scrubOutput(networkReason(error))}`);
      }
    },
    async close(): Promise<void> {
      closed = true;
      unsubscribe();
      for (const timer of scheduled.values()) timer.cancel();
      scheduled.clear();
      abort.abort();
      await Promise.all(running.values());
    },
  };
};
