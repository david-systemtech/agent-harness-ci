import { createHash } from "node:crypto";
import { AttentionTargetInput, type AttentionTargetStatus } from "@agent-harness/contracts";
import type { EventLog, Projector, ProjectionDb } from "../event-log/event-log.js";

export const attentionStream = { kind: "settings", id: "attention" } as const;
export const ATTENTION_GRACE_MS = 6000;
/** A prompt without a TTL still cannot leave a lock-screen delivery pending forever. */
export const ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export interface StoredTarget { readonly target: AttentionTargetInput; readonly owner: string | null; readonly version: string }
export interface PendingDelivery {
  readonly id: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly promptId: string | null;
  readonly expiresAt: number;
  readonly nextAt: number;
  readonly attempts: number;
  readonly state: "pending" | "sent" | "cancelled" | "failed";
}
interface TargetRow { id: string; owner: string | null; target: string; version: string }
interface DeliveryRow { id: string; target_id: string; session_id: string; event_id: string; prompt_id: string | null; expires_at: number; next_at: number; attempts: number; state: PendingDelivery["state"] }
interface Ask { event_id: string; session_id: string; prompt_id: string | null; opened_at: number; expires_at: number }

const enqueue = (db: ProjectionDb, ask: Ask, targetId: string): void => {
  db.run(`INSERT OR IGNORE INTO attention_deliveries (id, target_id, session_id, event_id, prompt_id, expires_at, next_at, attempts, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`, `attn_${createHash("sha256").update(JSON.stringify([ask.event_id, targetId])).digest("base64url")}`, targetId, ask.session_id, ask.event_id, ask.prompt_id,
  ask.expires_at, ask.opened_at + ATTENTION_GRACE_MS);
};

/** Queue insertion commits with the parked ask; a crash cannot fall between a subscriber and its write. */
export const attentionProjector: Projector = {
  name: "attention",
  tables: {
    attention_targets: "CREATE TABLE attention_targets (id TEXT PRIMARY KEY, owner TEXT, target TEXT NOT NULL, version TEXT NOT NULL) STRICT",
    attention_asks: `CREATE TABLE attention_asks (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt_id TEXT NOT NULL, opened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT`,
    attention_deliveries: `CREATE TABLE attention_deliveries (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, session_id TEXT NOT NULL, event_id TEXT NOT NULL,
      prompt_id TEXT, expires_at INTEGER NOT NULL, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL) STRICT;
      CREATE INDEX attention_due ON attention_deliveries (state, next_at)`,
    attention_firings: "CREATE TABLE attention_firings (routine_id TEXT NOT NULL, firing_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(routine_id, firing_id)) STRICT",
    attention_failures: "CREATE TABLE attention_failures (target_id TEXT PRIMARY KEY, failure TEXT NOT NULL) STRICT",
  },
  apply(event, db) {
    const p = event.payload;
    if (event.streamKind === "session" && event.type === "prompt.opened") {
      const opened = Date.parse(event.occurredAt);
      const ask: Ask = { event_id: event.eventId, session_id: event.streamId, prompt_id: String(p["promptId"]), opened_at: opened,
        expires_at: Math.min(opened + ATTENTION_MAX_AGE_MS, typeof p["ttlExpiresAt"] === "string" ? Date.parse(p["ttlExpiresAt"]) : Infinity) };
      db.run("INSERT INTO attention_asks VALUES (?, ?, ?, ?, ?)", ask.event_id, ask.session_id, ask.prompt_id, ask.opened_at, ask.expires_at);
      for (const row of db.all<TargetRow>("SELECT * FROM attention_targets")) {
        if (AttentionTargetInput.parse(JSON.parse(row.target)).enabled) enqueue(db, ask, row.id);
      }
    } else if (event.streamKind === "session" && event.type === "prompt.answered") {
      db.run("DELETE FROM attention_asks WHERE session_id = ? AND prompt_id = ?", event.streamId, String(p["promptId"]));
      db.run("UPDATE attention_deliveries SET state = 'cancelled' WHERE session_id = ? AND prompt_id = ? AND state = 'pending'", event.streamId, String(p["promptId"]));
    } else if (event.streamKind === "session" && ["session.deleted", "session.purged"].includes(event.type)) {
      db.run("DELETE FROM attention_asks WHERE session_id = ?", event.streamId);
      db.run("UPDATE attention_deliveries SET state = 'cancelled' WHERE session_id = ? AND state = 'pending'", event.streamId);
    } else if (event.streamKind === "routine" && event.type === "routine.firing-started") {
      db.run("INSERT INTO attention_firings VALUES (?, ?, ?)", event.streamId, String(p["firingId"]), String(p["sessionId"]));
    } else if (event.streamKind === "routine" && event.type === "routine.firing-ended") {
      const firing = db.get<{ session_id: string }>("SELECT session_id FROM attention_firings WHERE routine_id = ? AND firing_id = ?", event.streamId, String(p["firingId"]));
      if (firing && ["succeeded", "failed"].includes(String(p["outcome"]))) {
        const opened = Date.parse(event.occurredAt);
        for (const row of db.all<TargetRow>("SELECT * FROM attention_targets")) {
          const target = AttentionTargetInput.parse(JSON.parse(row.target));
          if (target.enabled && target.completion) enqueue(db, { event_id: event.eventId, session_id: firing.session_id, prompt_id: null, opened_at: opened, expires_at: opened + ATTENTION_MAX_AGE_MS }, target.id);
        }
      }
      db.run("DELETE FROM attention_firings WHERE routine_id = ? AND firing_id = ?", event.streamId, String(p["firingId"]));
    } else if (event.streamKind === attentionStream.kind && event.streamId === attentionStream.id) {
      if (event.type === "attention.target.set") {
        const target = AttentionTargetInput.parse(p["target"]);
        db.run("INSERT INTO attention_targets VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET target = excluded.target, version = excluded.version", target.id, p["owner"] as string | null, JSON.stringify(target), event.eventId);
        db.run("DELETE FROM attention_failures WHERE target_id = ?", target.id);
        if (!target.enabled) db.run("UPDATE attention_deliveries SET state = 'cancelled' WHERE target_id = ? AND state = 'pending'", target.id);
        else for (const ask of db.all<Ask>("SELECT * FROM attention_asks")) enqueue(db, ask, target.id);
        if (!target.completion) db.run("UPDATE attention_deliveries SET state = 'cancelled' WHERE target_id = ? AND prompt_id IS NULL AND state = 'pending'", target.id);
      } else if (event.type === "attention.target.removed") {
        db.run("DELETE FROM attention_targets WHERE id = ?", String(p["id"]));
        db.run("DELETE FROM attention_failures WHERE target_id = ?", String(p["id"]));
        db.run("UPDATE attention_deliveries SET state = 'cancelled' WHERE target_id = ? AND state = 'pending'", String(p["id"]));
      } else if (event.type === "attention.delivery.result") {
        db.run("UPDATE attention_deliveries SET state = ?, attempts = ?, next_at = ? WHERE id = ? AND state = 'pending'",
          String(p["state"]), Number(p["attempts"]), Number(p["nextAt"]), String(p["id"]));
        if (p["failure"] === null) db.run("DELETE FROM attention_failures WHERE target_id = ?", String(p["targetId"]));
        else db.run("INSERT INTO attention_failures VALUES (?, ?) ON CONFLICT(target_id) DO UPDATE SET failure = excluded.failure", String(p["targetId"]), String(p["failure"]));
      }
    }
  },
};

export interface AttentionStore {
  targets(): readonly StoredTarget[];
  deliveries(state?: PendingDelivery["state"]): readonly PendingDelivery[];
  status(available: (transport: AttentionTargetInput["transport"]) => boolean): readonly (AttentionTargetStatus & { readonly owner: string | null })[];
}
export const attentionStore = (log: EventLog): AttentionStore => {
  const targets = (): StoredTarget[] => log.read<TargetRow>("SELECT * FROM attention_targets ORDER BY id").map(row => ({ target: AttentionTargetInput.parse(JSON.parse(row.target)), owner: row.owner, version: row.version }));
  const deliveries = (state?: PendingDelivery["state"]): PendingDelivery[] => log.read<DeliveryRow>(`SELECT * FROM attention_deliveries ${state ? "WHERE state = ?" : ""} ORDER BY next_at, id`, ...(state ? [state] : [])).map(row => ({
    id: row.id, targetId: row.target_id, sessionId: row.session_id, eventId: row.event_id, promptId: row.prompt_id, expiresAt: row.expires_at, nextAt: row.next_at, attempts: row.attempts, state: row.state,
  }));
  return { targets, deliveries, status: available => targets().map(({ target, owner }) => {
    const failure = log.read<{ failure: string }>("SELECT failure FROM attention_failures WHERE target_id = ?", target.id)[0]?.failure ?? null;
    return { id: target.id, ...(target.label === undefined ? {} : { label: target.label }), transport: target.transport, enabled: target.enabled, completion: target.completion, global: owner === null, owner, failure,
      state: !target.enabled ? "disabled" : failure ? "failed" : !available(target.transport) ? "unavailable" : deliveries("pending").some(d => d.targetId === target.id) ? "pending" : "ready" };
  }) };
};
