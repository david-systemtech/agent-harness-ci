import {
  SESSION_STREAM_KIND,
  type MessageRequeuedPayload,
  type MessageSentPayload,
  type MessageDeliveredPayload,
  type RunEndedPayload,
  type RunStartedPayload,
  type SessionProviderLinkedPayload,
  type TasksChangedPayload,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector } from "../event-log/event-log.js";

/**
 * The runs projector: the read models the run methods and the adapter host
 * decide on, kept from the transcript events of every session's stream in
 * the transaction that appends them. `runs` has a row per run (its session,
 * state, account, model, times, how it ended, the provider's session id);
 * `run_messages` holds every queued message not yet read, and who holds it;
 * `run_tasks` a run's delegated-work ledger as its latest `tasks.changed`
 * left it. The tombstone (`session.purged`) removes the session's rows, as
 * the purge removed its events. The snapshot's items are not a table: they
 * are folded from the stream when a snapshot is read (`transcript.ts`).
 */

export const RUNS_PROJECTOR = "runs";

export const RUNS_TABLES = {
  runs: `CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'ended')),
    origin TEXT NOT NULL,
    account_id TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    reason TEXT,
    provider_session_id TEXT
  ) STRICT;
  CREATE INDEX runs_by_session ON runs (session_id, started_at)`,
  run_messages: `CREATE TABLE run_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    text TEXT NOT NULL,
    held_by TEXT NOT NULL CHECK (held_by IN ('provider', 'environment'))
  ) STRICT;
  CREATE INDEX run_messages_by_session ON run_messages (session_id, sequence)`,
  run_tasks: `CREATE TABLE run_tasks (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (run_id, task_id)
  ) STRICT`,
} as const;

type Projection = (event: EventEnvelope, db: ProjectionDb) => void;

const PROJECTIONS: Partial<Record<string, Projection>> = {
  "run.started": (event, db) => {
    const payload = event.payload as RunStartedPayload;
    db.run(
      `INSERT INTO runs (run_id, session_id, state, origin, account_id, model, started_at) VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      payload.runId,
      event.streamId,
      payload.origin,
      payload.accountId,
      payload.model,
      event.occurredAt,
    );
  },
  "run.ended": (event, db) => {
    const payload = event.payload as RunEndedPayload;
    db.run("UPDATE runs SET state = 'ended', ended_at = ?, reason = ? WHERE run_id = ?", event.occurredAt, payload.reason, payload.runId);
  },
  "session.provider-linked": (event, db) => {
    const payload = event.payload as SessionProviderLinkedPayload;
    db.run("UPDATE runs SET provider_session_id = ? WHERE run_id = ?", payload.providerSessionId, payload.runId);
  },
  "message.sent": (event, db) => {
    const payload = event.payload as MessageSentPayload;
    if (payload.delivery !== "queued" || payload.heldBy === null) return;
    db.run(
      "INSERT INTO run_messages (message_id, session_id, run_id, sequence, text, held_by) VALUES (?, ?, ?, ?, ?, ?)",
      payload.messageId,
      event.streamId,
      payload.runId,
      event.sequence,
      payload.text,
      payload.heldBy,
    );
  },
  "message.delivered": (event, db) => {
    db.run("DELETE FROM run_messages WHERE message_id = ?", (event.payload as MessageDeliveredPayload).messageId);
  },
  "message.requeued": (event, db) => {
    db.run("UPDATE run_messages SET held_by = 'environment' WHERE message_id = ?", (event.payload as MessageRequeuedPayload).messageId);
  },
  "tasks.changed": (event, db) => {
    const payload = event.payload as TasksChangedPayload;
    db.run("DELETE FROM run_tasks WHERE run_id = ?", payload.runId);
    for (const task of payload.tasks) {
      db.run(
        "INSERT OR REPLACE INTO run_tasks (run_id, task_id, session_id, status) VALUES (?, ?, ?, ?)",
        payload.runId,
        task.taskId,
        event.streamId,
        task.status,
      );
    }
  },
  "session.purged": (event, db) => {
    for (const table of Object.keys(RUNS_TABLES)) db.run(`DELETE FROM ${table} WHERE session_id = ?`, event.streamId);
  },
};

export const runsProjector: Projector = {
  name: RUNS_PROJECTOR,
  tables: RUNS_TABLES,
  apply(event, db) {
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    PROJECTIONS[event.type]?.(event, db);
  },
};
