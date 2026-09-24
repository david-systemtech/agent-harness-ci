import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createClientSessionTable, type ClientSessionTable } from "./client-sessions.js";
import { createSql, decodeEvent, toJson, type EventRow, type SqlValue, type Transaction } from "./database.js";
import { requireActor, type EventEnvelope, type EventInput, type JsonObject, type StreamRef } from "./envelope.js";
import { applyMigrations } from "./migrations.js";
import { createProjections, type Projector } from "./projectors.js";
import { createPairingTable, type PairingTable } from "./pairings.js";
import { createReceipts, type CommandReceipt, type ReceiptRequest } from "./receipts.js";
import { createSnapshots, type Snapshot } from "./snapshots.js";
import { loadSqlite } from "./sqlite.js";

export type { ClientSessionRow, ClientSessionTable } from "./client-sessions.js";
export type { PairingRow, PairingTable } from "./pairings.js";
export type { SqlValue } from "./database.js";
export { formatActor, parseActor, type EventEnvelope, type EventInput, type JsonObject, type StreamRef } from "./envelope.js";
export type { ProjectionDb, Projector } from "./projectors.js";
export { RECEIPT_RETENTION_MS, type CommandReceipt, type ReceiptRequest } from "./receipts.js";
export type { Snapshot } from "./snapshots.js";

/** The most a subscription replays for one stream before it sends a snapshot instead (spec: "Subscriptions"). */
export const REPLAY_BOUND = { events: 1000, bytes: 8 * 1024 * 1024 } as const;

/** How long a connection waits for another's write lock before an append fails. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * An open `atomically`: what an auth-table write and an access-log append
 * take, so none of them happens outside one. It is valid only while its
 * `atomically` runs.
 */
export interface Tx {
  /** Runs `callback` once the transaction has committed; never, if it rolls back. For memory that mirrors what was written. */
  afterCommit(callback: () => void): void;
}

interface AppendContext {
  /** The client session, routine, adapter or system component appending, as `kind:id` (`formatActor`); any other form is refused. */
  readonly actor: string;
  /** The `atomically` the append must be part of; the append throws unless it is the one open. */
  readonly tx?: Tx;
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

export interface AppendResult {
  /** The events written, as a reader will see them; empty for a repeated command. */
  readonly events: readonly EventEnvelope[];
  readonly receipt: CommandReceipt | null;
  /** True when the command id was already answered and nothing was appended. */
  readonly duplicate: boolean;
}

/** One stream's events after a cursor, measured against the replay bound. */
export interface ReplayMeasure {
  /** Events after the cursor, counted up to one past the bound. */
  readonly events: number;
  /** UTF-8 bytes of those events' payload and metadata. */
  readonly bytes: number;
  readonly withinBound: boolean;
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
  append(stream: StreamRef, events: readonly EventInput[], options: AppendOptions): AppendResult;
  /** One stream's events with a sequence above `afterSequence`, in order: every one, or the first `limit`. */
  readStream(stream: StreamRef, afterSequence?: number, limit?: number): EventEnvelope[];
  /** Measures one stream's events after a cursor against the replay bound, in SQL, before decoding. */
  replayBound(stream: StreamRef, afterSequence: number): ReplayMeasure;
  /** The last sequence the log has given out, on any stream; 0 before the first event. */
  head(): number;
  /**
   * Hears every committed event. Every subscriber hears sequences in
   * ascending order: events committed while subscribers are being called
   * (a subscriber that appends) are queued and published after the current ones.
   * Returns the unsubscribe.
   */
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  /** Creates the projector's tables if needed and catches it up from its cursor. */
  registerProjector(projector: Projector): void;
  /** Drops every registered projector's tables, recreates them and replays the whole log, in one transaction; returns the projectors' names. */
  rebuildProjections(): readonly string[];
  /** Reads rows (the projection read models, pragmas) with the connection query-only, so no write gets past the log. */
  read<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
  receipt(actor: string, commandId: string): CommandReceipt | null;
  /** Removes receipts older than the retention period at `now`; returns how many. */
  pruneReceipts(now: Date): number;
  /** Writes a stream's snapshot, replacing any earlier one. */
  writeSnapshot(stream: StreamRef, snapshot: { readonly sequence: number; readonly payload: unknown }): void;
  readSnapshot(stream: StreamRef): Snapshot | null;
  /**
   * Runs `work` in one write transaction, handing it the `Tx` that every
   * auth-table write and access-log append inside takes: all of it commits
   * together or not at all. After the commit the `afterCommit` callbacks run,
   * then subscribers hear the appended events. Neither a projector nor
   * another `atomically` may call it: one caller owns the transaction.
   */
  atomically<T>(work: (tx: Tx) => T): T;
  /** The auth table of client sessions, which the environment loads once on start and then only writes. */
  readonly clientSessions: ClientSessionTable;
  /** The auth table of pairing codes, loaded once on start and then only written. */
  readonly pairings: PairingTable;
  close(): void;
}

/** Throws unless `value` is a JSON object: the contracts' envelope carries payload and metadata as objects. */
const requireObject: (value: unknown, what: string) => asserts value is JsonObject = (value, what) => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return;
  const got = value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
  throw new TypeError(`${what} must be a JSON object; got ${got}.`);
};

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

  const sql = createSql(db);
  let closed = false;

  let inTransaction = false;
  /** The `atomically` open now: an append inside joins its transaction rather than opening one. */
  let openTx: Tx | undefined;
  /** Inside a projector's `apply`, which may not write anywhere but its own tables. */
  let projecting = false;
  /** Events appended inside `atomically`, published once it commits. */
  let held: EventEnvelope[] | undefined;

  /** BEGIN IMMEDIATE takes the write lock up front, so concurrent writers queue on the busy timeout. */
  const begin: Transaction = (work) => {
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

  /** An append's transaction: its own, or the one `atomically` holds open. */
  const transaction: Transaction = (work) => (openTx !== undefined && !projecting ? work() : begin(work));

  /** Throws unless `tx` is the `atomically` open now, and no projector is running. */
  const requireTx = (tx: Tx): void => {
    if (projecting) throw new Error("A projector may not append or write the auth tables.");
    if (tx !== openTx) throw new Error("This write needs the transaction of the atomically open now.");
  };

  const projections = createProjections(sql, begin, clock);
  const receipts = createReceipts(sql);
  const snapshots = createSnapshots(sql, clock);
  const clientSessions = createClientSessionTable(sql, requireTx);
  const pairings = createPairingTable(sql, requireTx);

  const insertEvent = `
    INSERT INTO events (event_id, stream_kind, stream_id, stream_version, type, occurred_at,
                        command_id, causation_id, correlation_id, actor, payload, metadata)
    SELECT ?1, ?2, ?3, COALESCE(MAX(stream_version), 0) + 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
    FROM events WHERE stream_kind = ?2 AND stream_id = ?3
    RETURNING *`;

  const listeners = new Set<(event: EventEnvelope) => void>();
  /** Committed events not yet delivered to every listener, oldest first. */
  const undelivered: EventEnvelope[] = [];
  let publishing = false;
  /**
   * Delivers events to every listener, one event at a time, first in first
   * out. A listener that appends queues its events behind the ones being
   * delivered, so no listener hears a later sequence before an earlier one.
   */
  const publish = (events: readonly EventEnvelope[]): void => {
    for (const event of events) undelivered.push(event);
    if (publishing) return;
    publishing = true;
    try {
      for (let event = undelivered.shift(); event; event = undelivered.shift()) {
        for (const listener of [...listeners]) {
          try {
            listener(event);
          } catch (error) {
            onSubscriberError(error);
          }
        }
      }
    } finally {
      publishing = false;
    }
  };

  const log: EventLog = {
    append(stream, inputs, options) {
      if (options.tx !== undefined) requireTx(options.tx);
      const request = options.receipt;
      if (request?.status === "rejected" && inputs.length > 0) {
        throw new TypeError(
          `A rejected command appends no events; command ${options.commandId} carried ${inputs.length}.`,
        );
      }
      requireActor(options.actor);
      for (const input of inputs) {
        requireObject(input.payload, `The payload of a ${input.type} event`);
        if (input.metadata !== undefined) requireObject(input.metadata, `The metadata of a ${input.type} event`);
      }
      const now = clock().toISOString();
      const rows: SqlValue[][] = inputs.map((input) => [
        input.eventId ?? randomUUID(),
        stream.kind,
        stream.id,
        input.type,
        input.occurredAt ?? now,
        options.commandId ?? null,
        options.causationId ?? null,
        options.correlationId ?? null,
        options.actor,
        toJson(input.payload, `The payload of a ${input.type} event`),
        toJson(input.metadata ?? {}, `The metadata of a ${input.type} event`),
      ]);

      const result = transaction((): AppendResult => {
        if (request) {
          const stored = receipts.read(options.actor, options.commandId);
          if (stored) return { events: [], receipt: stored, duplicate: true };
        }
        const events = rows.map((row) => decodeEvent(sql.get<EventRow>(insertEvent, ...row) as EventRow));
        projecting = true;
        try {
          projections.catchUp(events);
        } finally {
          projecting = false;
        }
        const receipt = request
          ? receipts.write(
              { actor: options.actor, commandId: options.commandId, stream, createdAt: now },
              request,
              events,
            )
          : null;
        return { events, receipt, duplicate: false };
      });
      if (held) held.push(...result.events);
      else publish(result.events);
      return result;
    },

    readStream(stream, afterSequence = 0, limit) {
      return sql
        .all<EventRow>(
          // SQLite reads a negative LIMIT as none.
          "SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
          stream.kind,
          stream.id,
          afterSequence,
          limit ?? -1,
        )
        .map(decodeEvent);
    },

    atomically(work) {
      if (projecting) throw new Error("A projector may not append or write the auth tables.");
      if (openTx !== undefined) throw new Error("An atomically is open already: its owner passes its Tx on rather than opening another.");
      const appended: EventEnvelope[] = [];
      const committed: (() => void)[] = [];
      const tx: Tx = { afterCommit: (callback) => void committed.push(callback) };
      const result = begin(() => {
        openTx = tx;
        held = appended;
        try {
          return work(tx);
        } finally {
          openTx = undefined;
          held = undefined;
        }
      });
      for (const callback of committed) {
        try {
          callback();
        } catch (error) {
          onSubscriberError(error);
        }
      }
      publish(appended);
      return result;
    },

    replayBound(stream, afterSequence) {
      // The scan stops one event past the count bound, so an old, long stream costs no more than the bound.
      const row = sql.get<{ events: number; bytes: number }>(
        `SELECT COUNT(*) AS events,
                COALESCE(SUM(length(CAST(payload AS BLOB)) + length(CAST(metadata AS BLOB))), 0) AS bytes
         FROM (SELECT payload, metadata FROM events
               WHERE stream_kind = ? AND stream_id = ? AND sequence > ?
               ORDER BY sequence LIMIT ?)`,
        stream.kind,
        stream.id,
        afterSequence,
        REPLAY_BOUND.events + 1,
      ) ?? { events: 0, bytes: 0 };
      return {
        events: row.events,
        bytes: row.bytes,
        withinBound: row.events <= REPLAY_BOUND.events && row.bytes <= REPLAY_BOUND.bytes,
      };
    },

    head() {
      // The autoincrement's own counter: what a rolled-back append never took, and what a purge never lowers.
      return sql.get<{ head: number }>("SELECT seq AS head FROM sqlite_sequence WHERE name = 'events'")?.head ?? 0;
    },

    subscribe(listener) {
      const own = (event: EventEnvelope) => listener(event);
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },

    registerProjector: (projector) => projections.register(projector),
    rebuildProjections: () => projections.rebuild(),

    read<Row>(text: string, ...params: readonly SqlValue[]) {
      db.exec("PRAGMA query_only = ON");
      try {
        return sql.all<Row>(text, ...params);
      } finally {
        db.exec("PRAGMA query_only = OFF");
      }
    },

    receipt: (actor, commandId) => receipts.read(actor, commandId),
    pruneReceipts: (now) => receipts.prune(now),
    writeSnapshot: (stream, snapshot) => snapshots.write(stream, snapshot),
    readSnapshot: (stream) => snapshots.read(stream),
    clientSessions,
    pairings,

    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      undelivered.length = 0;
      sql.clear();
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
