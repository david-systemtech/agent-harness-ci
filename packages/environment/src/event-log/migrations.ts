import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "./sqlite.js";

/** One step of the log's own schema. `version` is its position, from 1. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * The log's schema, in order; only ever appended to. The database's
 * `user_version` is the version of the last migration applied. Projection
 * tables are not here: each projector declares and creates its own.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "events, command receipts, projection cursors and snapshots",
    sql: `
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL CHECK (stream_version > 0),
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        causation_id TEXT,
        correlation_id TEXT,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE (stream_kind, stream_id, stream_version)
      ) STRICT;
      CREATE INDEX events_by_stream ON events (stream_kind, stream_id, sequence);

      CREATE TABLE command_receipts (
        actor TEXT NOT NULL,
        command_id TEXT NOT NULL,
        stream_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
        changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
        resulting_sequence INTEGER,
        error_reason TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor, command_id),
        CHECK ((status = 'rejected') = (error_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX command_receipts_by_age ON command_receipts (created_at);

      CREATE TABLE projection_state (
        name TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE snapshots (
        stream_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stream_kind, stream_id)
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "auth: client sessions",
    sql: `
      CREATE TABLE client_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        scopes TEXT NOT NULL,
        ceiling TEXT NOT NULL,
        local INTEGER NOT NULL CHECK (local IN (0, 1)),
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "auth: pairings",
    // The code itself is never stored: a code is looked up by its SHA-256.
    sql: `
      CREATE TABLE pairings (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        ceiling TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        exchanged_at TEXT,
        client_session_id TEXT REFERENCES client_sessions (id),
        expired_at TEXT,
        CHECK ((exchanged_at IS NULL) = (client_session_id IS NULL)),
        CHECK (exchanged_at IS NULL OR expired_at IS NULL)
      ) STRICT;
    `,
  },
];

const userVersion = (db: DatabaseSync): number => {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"] ?? 0);
};

/**
 * Applies every migration newer than the database's `user_version`, each in
 * its own transaction with the version bump, and refuses a database whose
 * version is newer than the last migration this build knows.
 */
export const applyMigrations = (db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void => {
  const latest = migrations.at(-1)?.version ?? 0;
  const current = userVersion(db);
  if (current > latest) {
    throw new Error(
      `The event log's schema is version ${current}, newer than this build's ${latest}; refusing to open it.`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another connection may have migrated between the read above and the lock.
      if (userVersion(db) < migration.version) {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      // SQLite rolls back on its own after some failures (disk full, I/O error); a second ROLLBACK would mask the cause.
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
};

let migratedTables: ReadonlySet<string> | undefined;

/**
 * The tables the migrations create, which no projector may claim: found by
 * migrating a scratch in-memory database, so a later migration's tables are
 * protected without a second list to keep in step.
 */
export const logTables = (): ReadonlySet<string> => {
  if (!migratedTables) {
    const scratch = new (loadSqlite().DatabaseSync)(":memory:");
    try {
      applyMigrations(scratch);
      const rows = scratch
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
      migratedTables = new Set(rows.map((row) => String(row["name"])));
    } finally {
      scratch.close();
    }
  }
  return migratedTables;
};
