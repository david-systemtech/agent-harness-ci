import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { EventEnvelope, EventInput, JsonObject } from "./envelope.js";
import { applyMigrations, logTables } from "./migrations.js";
import { loadSqlite } from "./sqlite.js";

/** The most a subscription replays for one stream before it sends a snapshot instead (spec: "Subscriptions"). */
export const REPLAY_BOUND = { events: 1000, bytes: 8 * 1024 * 1024 } as const;

/** How long a command receipt is kept. */
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a connection waits for another's write lock before an append fails. */
const BUSY_TIMEOUT_MS = 5000;

/** Events read per page when a projector catches up. */
const CATCH_UP_PAGE = 500;

/** The narrow handle a projector writes its tables through. */
export interface ProjectionDb {
  run(sql: string, ...params: SQLInputValue[]): void;
  get<Row = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): Row | undefined;
  all<Row = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): Row[];
}

/**
 * A named read model kept from the log. It owns the tables it declares, each
 * with the statements that create it (and its indexes); a rebuild drops
 * exactly those and creates them again. `apply` runs inside the transaction of
 * the append that wrote the event, so it must write only its own tables and
 * must not append, register or rebuild.
 */
export interface Projector {
  readonly name: string;
  readonly tables: Readonly<Record<string, string>>;
  apply(event: EventEnvelope, db: ProjectionDb): void;
}

/** What a command's receipt records: accepted, or rejected with a reason such as `not_found`. */
export type ReceiptRequest =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: string; readonly message?: string };

interface AppendContext {
  /** The client session, routine, adapter or system component appending. */
  readonly actor: string;
  readonly causationId?: string;
  readonly correlationId?: string;
}

/**
 * How an append is attributed. A `receipt` makes the append a command: it
 * needs the command id, it is answered from the stored receipt when the same
 * actor repeats that id, and the receipt is written in the append's transaction.
 */
export type AppendOptions = AppendContext &
  (
    | { readonly commandId?: string; readonly receipt?: undefined }
    | { readonly commandId: string; readonly receipt: ReceiptRequest }
  );

interface ReceiptBase {
  readonly actor: string;
  readonly commandId: string;
  /** The aggregate the command was aimed at. */
  readonly streamKind: string;
  readonly streamId: string;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
}

export type CommandReceipt = ReceiptBase &
  (
    | {
        readonly status: "accepted";
        /** False for a command that was accepted but changed nothing. */
        readonly changed: boolean;
        /** The sequence of the command's last event; null when it appended none. */
        readonly resultingSequence: number | null;
      }
    | { readonly status: "rejected"; readonly changed: false; readonly reason: string; readonly message: string | null }
  );

export interface AppendResult {
  /** The events written, as a reader will see them; empty for a repeated command. */
  readonly events: readonly EventEnvelope[];
  readonly receipt: CommandReceipt | null;
  /** True when the command id was already answered and nothing was appended. */
  readonly duplicate: boolean;
}

export interface ReplayBound {
  /** Events after the cursor, counted up to one past the bound. */
  readonly events: number;
  /** UTF-8 bytes of those events' payload and metadata. */
  readonly bytes: number;
  readonly withinBound: boolean;
}

export interface Snapshot {
  readonly streamKind: string;
  readonly streamId: string;
  /** The sequence of the last event the snapshot folds in. */
  readonly sequence: number;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface EventLogOptions {
  /** A database file, or `:memory:` for a private in-memory database. */
  readonly path: string;
  /** Registered, and caught up from their cursors, before `openEventLog` returns. */
  readonly projectors?: readonly Projector[];
  readonly clock?: () => Date;
  /** Where a subscriber's exception goes; it never fails the append that published. */
  readonly onSubscriberError?: (error: unknown) => void;
}

export interface EventLog {
  /**
   * Appends events to one stream in one transaction with every projector's
   * writes and the receipt; subscribers hear of them only after it commits.
   */
  append(streamKind: string, streamId: string, events: readonly EventInput[], options: AppendOptions): AppendResult;
  /** One stream's events with a sequence above `afterSequence`, in order. */
  readStream(streamKind: string, streamId: string, afterSequence?: number): EventEnvelope[];
  /** Whether one stream's events after a cursor fit the replay bound, measured in SQL before decoding. */
  replayBound(streamKind: string, streamId: string, afterSequence: number): ReplayBound;
  /** Hears every committed event, in sequence order. Returns the unsubscribe. */
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  /** Creates the projector's tables if needed and catches it up from its cursor. */
  registerProjector(projector: Projector): void;
  /** Drops every registered projector's tables, recreates them and replays the whole log, in one transaction. */
  rebuildProjections(): void;
  /** Reads rows: the projection read models, or anything else in the database. */
  query<Row = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): Row[];
  receipt(actor: string, commandId: string): CommandReceipt | null;
  /** Removes receipts older than the retention period at `now`; returns how many. */
  pruneReceipts(now: Date): number;
  /** Writes a stream's snapshot, replacing any earlier one. */
  writeSnapshot(streamKind: string, streamId: string, snapshot: { sequence: number; payload: unknown }): void;
  readSnapshot(streamKind: string, streamId: string): Snapshot | null;
  close(): void;
}

interface EventRow {
  sequence: number;
  event_id: string;
  stream_kind: string;
  stream_id: string;
  stream_version: number;
  type: string;
  occurred_at: string;
  command_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  actor: string;
  payload: string;
  metadata: string;
}

interface ReceiptRow {
  actor: string;
  command_id: string;
  stream_kind: string;
  stream_id: string;
  status: "accepted" | "rejected";
  changed: number;
  resulting_sequence: number | null;
  error_reason: string | null;
  error_message: string | null;
  created_at: string;
}

interface SnapshotRow {
  stream_kind: string;
  stream_id: string;
  sequence: number;
  payload: string;
  created_at: string;
}

const decodeEvent = (row: EventRow): EventEnvelope => ({
  sequence: row.sequence,
  eventId: row.event_id,
  streamKind: row.stream_kind,
  streamId: row.stream_id,
  streamVersion: row.stream_version,
  type: row.type,
  occurredAt: row.occurred_at,
  commandId: row.command_id,
  causationId: row.causation_id,
  correlationId: row.correlation_id,
  actor: row.actor,
  payload: JSON.parse(row.payload) as unknown,
  metadata: JSON.parse(row.metadata) as JsonObject,
});

const decodeReceipt = (row: ReceiptRow): CommandReceipt => {
  const base: ReceiptBase = {
    actor: row.actor,
    commandId: row.command_id,
    streamKind: row.stream_kind,
    streamId: row.stream_id,
    createdAt: row.created_at,
  };
  return row.status === "accepted"
    ? { ...base, status: "accepted", changed: row.changed === 1, resultingSequence: row.resulting_sequence }
    : { ...base, status: "rejected", changed: false, reason: row.error_reason ?? "", message: row.error_message };
};

const toJson = (value: unknown, what: string): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`${what} is not a JSON value.`);
  return json;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const configure = (db: DatabaseSync, path: string): void => {
  const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.["journal_mode"];
  // An in-memory database has no file to keep a write-ahead log in and reports `memory`.
  if (mode !== "wal" && !(path === ":memory:" && mode === "memory")) {
    throw new Error(`The event log could not switch ${path} to WAL mode (journal mode is ${String(mode)}).`);
  }
  db.exec("PRAGMA foreign_keys = ON");
};

/** Opens (creating if needed) an environment's event log, migrates it and catches its projectors up. */
export const openEventLog = (options: EventLogOptions): EventLog => {
  const { DatabaseSync } = loadSqlite();
  const clock = options.clock ?? (() => new Date());
  const onSubscriberError =
    options.onSubscriberError ?? ((error: unknown) => console.error("An event log subscriber threw:", error));

  const db = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });
  try {
    configure(db, options.path);
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  const all = <Row>(sql: string, ...params: SQLInputValue[]): Row[] =>
    statement(sql).all(...params) as unknown as Row[];
  const get = <Row>(sql: string, ...params: SQLInputValue[]): Row | undefined =>
    statement(sql).get(...params) as unknown as Row | undefined;

  let inTransaction = false;
  /** BEGIN IMMEDIATE takes the write lock up front, so concurrent writers queue on the busy timeout. */
  const transaction = <T>(work: () => T): T => {
    if (inTransaction) {
      throw new Error("The event log does not nest transactions: a projector may not append, register or rebuild.");
    }
    inTransaction = true;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      inTransaction = false;
    }
  };

  const projectionDb: ProjectionDb = {
    run: (sql, ...params) => {
      statement(sql).run(...params);
    },
    get: <Row>(sql: string, ...params: SQLInputValue[]) => get<Row>(sql, ...params),
    all: <Row>(sql: string, ...params: SQLInputValue[]) => all<Row>(sql, ...params),
  };

  const projectors: Projector[] = [];
  /** Every table a projector owns, to the projector that owns it. */
  const tableOwners = new Map<string, string>();

  const cursorOf = (name: string): number | undefined =>
    get<{ cursor: number }>("SELECT cursor FROM projection_state WHERE name = ?", name)?.cursor;

  const setCursor = (name: string, cursor: number): void => {
    statement(
      `INSERT INTO projection_state (name, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(name, cursor, clock().toISOString());
  };

  const tableExists = (name: string): boolean =>
    get("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?", name) !== undefined;

  /** Drops the projector's tables, creates them again and puts its cursor back to zero. */
  const resetProjector = (projector: Projector): void => {
    for (const table of Object.keys(projector.tables).reverse()) db.exec(`DROP TABLE IF EXISTS "${table}"`);
    for (const [table, sql] of Object.entries(projector.tables)) {
      db.exec(sql);
      if (!tableExists(table)) {
        throw new Error(`Projector ${projector.name} declared table ${table}, but its statements did not create it.`);
      }
    }
    setCursor(projector.name, 0);
  };

  /**
   * Applies every event above the projector's cursor and moves the cursor to
   * the last. `fresh` are events this append just wrote, used as they are when
   * they follow the cursor directly, rather than read back and decoded again.
   */
  const catchUp = (projector: Projector, fresh: readonly EventEnvelope[] = []): void => {
    const start = cursorOf(projector.name) ?? 0;
    let cursor = start;
    const first = fresh[0];
    if (first && first.sequence === cursor + 1) {
      for (const event of fresh) {
        projector.apply(event, projectionDb);
        cursor = event.sequence;
      }
    } else {
      for (;;) {
        const rows = all<EventRow>(
          `SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ${CATCH_UP_PAGE}`,
          cursor,
        );
        for (const row of rows) {
          projector.apply(decodeEvent(row), projectionDb);
          cursor = row.sequence;
        }
        if (rows.length < CATCH_UP_PAGE) break;
      }
    }
    if (cursor !== start) setCursor(projector.name, cursor);
  };

  const insertEvent = statement(
    `INSERT INTO events (event_id, stream_kind, stream_id, stream_version, type, occurred_at,
                         command_id, causation_id, correlation_id, actor, payload, metadata)
     SELECT :event_id, :stream_kind, :stream_id, COALESCE(MAX(stream_version), 0) + 1, :type, :occurred_at,
            :command_id, :causation_id, :correlation_id, :actor, :payload, :metadata
     FROM events WHERE stream_kind = :stream_kind AND stream_id = :stream_id
     RETURNING *`,
  );

  const readReceipt = (actor: string, commandId: string): CommandReceipt | null => {
    const row = get<ReceiptRow>("SELECT * FROM command_receipts WHERE actor = ? AND command_id = ?", actor, commandId);
    return row ? decodeReceipt(row) : null;
  };

  const writeReceipt = (
    base: ReceiptBase,
    request: ReceiptRequest,
    events: readonly EventEnvelope[],
  ): CommandReceipt => {
    const receipt: CommandReceipt =
      request.status === "accepted"
        ? {
            ...base,
            status: "accepted",
            changed: events.length > 0,
            resultingSequence: events.at(-1)?.sequence ?? null,
          }
        : { ...base, status: "rejected", changed: false, reason: request.reason, message: request.message ?? null };
    statement(
      `INSERT INTO command_receipts (actor, command_id, stream_kind, stream_id, status, changed,
                                     resulting_sequence, error_reason, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.actor,
      receipt.commandId,
      receipt.streamKind,
      receipt.streamId,
      receipt.status,
      receipt.changed ? 1 : 0,
      receipt.status === "accepted" ? receipt.resultingSequence : null,
      receipt.status === "rejected" ? receipt.reason : null,
      receipt.status === "rejected" ? receipt.message : null,
      receipt.createdAt,
    );
    return receipt;
  };

  const listeners = new Set<(event: EventEnvelope) => void>();
  const publish = (events: readonly EventEnvelope[]): void => {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onSubscriberError(error);
        }
      }
    }
  };

  const log: EventLog = {
    append(streamKind, streamId, inputs, options) {
      const request = options.receipt;
      if (request?.status === "rejected" && inputs.length > 0) {
        throw new TypeError(
          `A rejected command appends no events; command ${options.commandId} carried ${inputs.length}.`,
        );
      }
      const now = clock().toISOString();
      const rows = inputs.map((input) => ({
        event_id: input.eventId ?? randomUUID(),
        stream_kind: streamKind,
        stream_id: streamId,
        type: input.type,
        occurred_at: input.occurredAt ?? now,
        command_id: options.commandId ?? null,
        causation_id: options.causationId ?? null,
        correlation_id: options.correlationId ?? null,
        actor: options.actor,
        payload: toJson(input.payload, `The payload of a ${input.type} event`),
        metadata: toJson(input.metadata ?? {}, `The metadata of a ${input.type} event`),
      }));

      const result = transaction((): AppendResult => {
        if (request) {
          const stored = readReceipt(options.actor, options.commandId);
          if (stored) return { events: [], receipt: stored, duplicate: true };
        }
        const events = rows.map((row) => decodeEvent(insertEvent.get(row) as unknown as EventRow));
        for (const projector of projectors) catchUp(projector, events);
        const receipt = request
          ? writeReceipt(
              { actor: options.actor, commandId: options.commandId, streamKind, streamId, createdAt: now },
              request,
              events,
            )
          : null;
        return { events, receipt, duplicate: false };
      });
      publish(result.events);
      return result;
    },

    readStream(streamKind, streamId, afterSequence = 0) {
      return all<EventRow>(
        "SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND sequence > ? ORDER BY sequence",
        streamKind,
        streamId,
        afterSequence,
      ).map(decodeEvent);
    },

    replayBound(streamKind, streamId, afterSequence) {
      // The scan stops one event past the count bound, so an old, long stream costs no more than the bound.
      const row = get<{ events: number; bytes: number }>(
        `SELECT COUNT(*) AS events,
                COALESCE(SUM(length(CAST(payload AS BLOB)) + length(CAST(metadata AS BLOB))), 0) AS bytes
         FROM (SELECT payload, metadata FROM events
               WHERE stream_kind = ? AND stream_id = ? AND sequence > ?
               ORDER BY sequence LIMIT ?)`,
        streamKind,
        streamId,
        afterSequence,
        REPLAY_BOUND.events + 1,
      ) ?? { events: 0, bytes: 0 };
      return {
        events: row.events,
        bytes: row.bytes,
        withinBound: row.events <= REPLAY_BOUND.events && row.bytes <= REPLAY_BOUND.bytes,
      };
    },

    subscribe(listener) {
      const own = (event: EventEnvelope) => listener(event);
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },

    registerProjector(projector) {
      if (projectors.some((p) => p.name === projector.name)) {
        throw new Error(`A projector named ${projector.name} is already registered.`);
      }
      for (const table of Object.keys(projector.tables)) {
        if (!IDENTIFIER.test(table) || table.startsWith("sqlite_")) {
          throw new Error(`Projector ${projector.name} declared ${JSON.stringify(table)}, which is not a table name.`);
        }
        if (logTables().has(table)) throw new Error(`Table ${table} is owned by the event log itself.`);
        const owner = tableOwners.get(table);
        if (owner) throw new Error(`Table ${table} is owned by projector ${owner}.`);
      }
      transaction(() => {
        // No cursor, or a declared table missing: the read model cannot be trusted, so it starts again from zero.
        const fresh =
          cursorOf(projector.name) === undefined || Object.keys(projector.tables).some((table) => !tableExists(table));
        if (fresh) resetProjector(projector);
        catchUp(projector);
      });
      projectors.push(projector);
      for (const table of Object.keys(projector.tables)) tableOwners.set(table, projector.name);
    },

    rebuildProjections() {
      transaction(() => {
        for (const projector of projectors) resetProjector(projector);
        for (const projector of projectors) catchUp(projector);
      });
    },

    query(sql, ...params) {
      return all(sql, ...params);
    },

    receipt(actor, commandId) {
      return readReceipt(actor, commandId);
    },

    pruneReceipts(now) {
      const cutoff = new Date(now.getTime() - RECEIPT_RETENTION_MS).toISOString();
      return Number(statement("DELETE FROM command_receipts WHERE created_at < ?").run(cutoff).changes);
    },

    writeSnapshot(streamKind, streamId, snapshot) {
      statement(
        `INSERT INTO snapshots (stream_kind, stream_id, sequence, payload, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (stream_kind, stream_id) DO UPDATE
         SET sequence = excluded.sequence, payload = excluded.payload, created_at = excluded.created_at`,
      ).run(
        streamKind,
        streamId,
        snapshot.sequence,
        toJson(snapshot.payload, "A snapshot payload"),
        clock().toISOString(),
      );
    },

    readSnapshot(streamKind, streamId) {
      const row = get<SnapshotRow>(
        "SELECT * FROM snapshots WHERE stream_kind = ? AND stream_id = ?",
        streamKind,
        streamId,
      );
      return row
        ? {
            streamKind: row.stream_kind,
            streamId: row.stream_id,
            sequence: row.sequence,
            payload: JSON.parse(row.payload) as unknown,
            createdAt: row.created_at,
          }
        : null;
    },

    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      statements.clear();
      db.close();
    },
  };

  try {
    for (const projector of options.projectors ?? []) log.registerProjector(projector);
  } catch (error) {
    log.close();
    throw error;
  }
  return log;
};
