import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createClientSessionTable, type ClientSessionTable } from "./client-sessions.js";
import { createSql, decodeEvent, toJson, type EventRow, type SqlValue, type Transaction } from "./database.js";
import { requireActor, type EventEnvelope, type EventInput, type JsonObject, type StreamRef } from "./envelope.js";
import { selection, type StreamSelector } from "./stream-selector.js";
import { applyMigrations } from "./migrations.js";
import { createProjections, type Projector } from "./projectors.js";
import { createPairingTable, type PairingTable } from "./pairings.js";
import { createProviderTranscriptTable, type ProviderTranscriptTable } from "../provider-transcripts/table.js";
import { createSetupResultTable, type SetupResultTable } from "../setup/result-table.js";
import { createSkillSourceAttemptTable, type SkillSourceAttemptTable } from "../skills/attempt-table.js";
import { createFileChangeTable, type FileChangeTable } from "../file-undo/change-table.js";
import { createReceipts, type StoredError, type StoredReceipt } from "./receipts.js";
import { createSnapshots, type Compaction, type Snapshot } from "./snapshots.js";
import { loadSqlite } from "./sqlite.js";

export type { ClientSessionRow, ClientSessionTable } from "./client-sessions.js";
export type { PairingRow, PairingTable } from "./pairings.js";
export type { SqlValue } from "./database.js";
export { formatActor, parseActor, type EventEnvelope, type EventInput, type JsonObject, type StreamRef } from "./envelope.js";
export { selection, type Selection, type StreamKinds, type StreamSelector } from "./stream-selector.js";
export type { ProjectionContext, ProjectionDb, Projector } from "./projectors.js";
export { RECEIPT_RETENTION_MS, type StoredError, type StoredReceipt } from "./receipts.js";
export type { Compaction, Snapshot } from "./snapshots.js";

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
  /**
   * Runs `callback` once the transaction has committed, before subscribers hear its events; never, if it rolls
   * back. For memory that mirrors what was written, and for work the commit sets off: a callback may append in an
   * `atomically` of its own, whose events subscribers hear after the ones of the transaction that committed.
   */
  afterCommit(callback: () => void): void;
}

/** How an append is attributed. */
export interface AppendOptions {
  /** The client session, routine, adapter or system component appending, as `kind:id` (`formatActor`); any other form is refused. */
  readonly actor: string;
  /** The `atomically` the append must be part of; the append throws unless it is the one open. */
  readonly tx?: Tx;
  /** The command that caused the events, when one did; `command` passes its own for the events it appends. */
  readonly commandId?: string;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export interface AppendResult {
  /** The events written, as a reader will see them. */
  readonly events: readonly EventEnvelope[];
}

/** Who sent a command, as its receipt is keyed: the actor as `kind:id`, and the command's client-generated id. */
export interface CommandKey {
  readonly actor: string;
  readonly commandId: string;
}

/**
 * What a command's work decides: the aggregate it was aimed at, then either
 * its result, with the events the log appends for it (the work may also
 * append through its `Tx`), or its rejection, stored as the error it gives,
 * which appends nothing.
 */
export type CommandOutcome<T> =
  | {
      readonly aggregate: StreamRef;
      readonly result: T;
      readonly events?: readonly EventInput[];
      readonly rejected?: undefined;
    }
  | { readonly aggregate: StreamRef; readonly rejected: StoredError };

/** How a command went: answered from the receipt of an earlier one with its key, or run now. */
export type CommandRun<T> =
  | { readonly replayed: true; readonly receipt: StoredReceipt }
  | {
      readonly replayed: false;
      readonly receipt: StoredReceipt;
      /** Every event the command appended, in order. */
      readonly events: readonly EventEnvelope[];
      /** The work's result; undefined for a rejection. */
      readonly result: T | undefined;
    };

/** One stream's events after a cursor, measured against the replay bound. */
export interface ReplayMeasure {
  /** Events after the cursor, counted up to one past the bound. */
  readonly events: number;
  /** UTF-8 bytes of those events' payload and metadata. */
  readonly bytes: number;
  readonly withinBound: boolean;
}

/** Where a replay from a cursor starts (`replayStart`). */
export interface ReplayStart {
  /** The sequence replay reads the events after: the cursor, or the snapshot's sequence when the snapshot stands in for events below it. */
  readonly after: number;
  /** The snapshot sent before those events, standing in for the stream's events at or below its sequence; null when replay is the events alone. */
  readonly snapshot: Snapshot | null;
}

export interface EventLogOptions {
  /** A database file, or `:memory:` for a private in-memory database. */
  readonly path: string;
  /** Registered, and caught up from their cursors, before `openEventLog` returns. */
  readonly projectors?: readonly Projector[];
  readonly clock?: () => Date;
  /** Where a subscriber's exception goes; it never fails the append that published. */
  readonly onSubscriberError?: (error: unknown) => void;
  /**
   * Answers each string of an event's payload, keys included, as the append
   * writes it: the scrub registry's (ADR 0011), so what is stored, projected
   * and published never holds a value registered when it was appended. An
   * event already appended is never rewritten. Preset: every string as it is.
   */
  readonly scrub?: (text: string) => string;
}

export interface EventLog {
  /**
   * Appends events to one stream in one transaction with every projector's
   * writes and the receipt; subscribers hear of them only after it commits.
   * The events returned, stored and published carry whatever metadata the
   * projectors attached while applying them (`ProjectionContext`).
   */
  append(stream: StreamRef, events: readonly EventInput[], options: AppendOptions): AppendResult;
  /**
   * The events `selector` names (one stream, or every stream of some kinds)
   * with a sequence above `afterSequence`, in order: every one, or the first `limit`.
   */
  readStream(selector: StreamSelector, afterSequence?: number, limit?: number): EventEnvelope[];
  /**
   * Runs a command once per actor and command id (env spec, "Commands"). A
   * key with a receipt in the retention period is answered from it and `work`
   * does not run. Otherwise `work` runs inside one `atomically`, the events
   * it names are appended to its aggregate with the key's actor and command
   * id, and its receipt is written in the same transaction: accepted, with
   * the head after it and whether it appended anything, or rejected. A throw
   * rolls all of it back and stores no receipt, so a retry runs again.
   */
  command<T>(key: CommandKey, work: (tx: Tx) => CommandOutcome<T>): CommandRun<T>;
  /** Measures the events `selector` names after a cursor against the replay bound, in SQL, before decoding. */
  replayBound(selector: StreamSelector, afterSequence: number): ReplayMeasure;
  /**
   * Where a replay of `selector` from `afterSequence` starts. A stream's
   * snapshot stands in for its events at or below the snapshot's sequence
   * (a compaction removed some of them): a cursor below it is answered with
   * the snapshot, then the events after it, and the replay bound is measured
   * from there. A cursor at or above it, a stream with no snapshot, and a
   * selection of many streams replay the events after the cursor.
   */
  replayStart(selector: StreamSelector, afterSequence: number): ReplayStart;
  /** The last sequence the log has given out, on any stream; 0 before the first event. */
  head(): number;
  /**
   * Hears every committed event. Every subscriber hears sequences in
   * ascending order: events committed while subscribers are being called
   * (a subscriber that appends) are queued and published after the current ones.
   * Returns the unsubscribe.
   */
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  /**
   * Creates the projector's tables if needed and catches it up from its
   * cursor; rebuilds it from the log instead when a declared table is missing
   * or its statements in the database differ from the declared ones.
   */
  registerProjector(projector: Projector): void;
  /** Drops every registered projector's tables, recreates them and replays the whole log, in one transaction; returns the projectors' names. */
  rebuildProjections(): readonly string[];
  /** Reads rows (the projection read models, pragmas) with the connection query-only, so no write gets past the log. */
  read<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
  /** The receipt stored for an actor's command id, while the retention period keeps it. */
  receipt(actor: string, commandId: string): StoredReceipt | null;
  /** Removes receipts older than the retention period at `now`; returns how many. The environment's minute sweep calls it. */
  pruneReceipts(now: Date): number;
  /**
   * Deletes every event of one stream and its snapshot, inside the
   * `atomically` open now: the removal of a whole stream, which a purge
   * makes (env spec, "Deletion") before it appends the stream's tombstone in
   * the same transaction; a compaction (`compactStream`) is the other
   * removal, of some events. The head is never lowered, so no sequence is
   * given out twice; the stream's next event is its version 1 again, the
   * snapshot that held its versions up being gone with it. Neither a
   * projector nor a caller without the open transaction may call it.
   * Returns how many events it deleted.
   */
  purgeStream(stream: StreamRef, options: { readonly tx: Tx }): number;
  /**
   * Compacts one stream inside the `atomically` open now (env spec, "The
   * event log": compaction): writes the snapshot that stands in, for replay,
   * for the stream's events at or below `compaction.sequence`, replacing any
   * earlier one, and removes the events it names, each of which must be the
   * stream's and at or below that sequence. The stream's versions keep
   * rising: its next event is numbered above the last one the snapshot
   * folds, though a compaction removed it. The head is untouched and nothing
   * is appended, so no subscriber hears of it. Which events a stream may
   * lose is its owner's rule (`sessions/compaction.ts`). Neither a projector
   * nor a caller without the open transaction may call it. Returns how many
   * events it removed.
   */
  compactStream(stream: StreamRef, compaction: Compaction, options: { readonly tx: Tx }): number;
  /**
   * The stream's snapshot, one at most: its compaction's, which stands in
   * for its events at or below its sequence (`compactStream` is the one
   * writer, so no other row can be read as one).
   */
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
  /** The SDK session store's tables (#137, `provider-transcripts/`): opaque provider state beside the log, written only in an `atomically`. */
  readonly providerTranscripts: ProviderTranscriptTable;
  /** Set up's result cache (#569, `setup/result-table.ts`): each step's latest result beside the log, written only in an `atomically`. */
  readonly setupResults: SetupResultTable;
  /** Skill sources' last attempt times (#936), beside the log and retained by a projection rebuild. */
  readonly skillSourceAttempts: SkillSourceAttemptTable;
  /** File undo's change records and restores under way (#1183, `file-undo/change-table.ts`), beside the log, written only in an `atomically`. */
  readonly fileChanges: FileChangeTable;
  close(): void;
}

/** The keys an `EventInput` has; an append refuses any other, so nothing meant for it is silently dropped. */
const EVENT_INPUT_KEYS: ReadonlySet<string> = new Set(["type", "payload", "metadata", "eventId", "occurredAt"] satisfies (keyof EventInput)[]);

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
  const { scrub } = options;

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

  // A rebuild inside an `atomically` (the `environment.rebuildProjections` command) joins its transaction.
  /**
   * Writes the metadata the projectors attached to an event being appended,
   * merged with what it had, to its row: the one write to `events` besides
   * the insert, and the log's own.
   */
  const attachMetadata = (event: EventEnvelope, metadata: JsonObject): void => {
    sql.run("UPDATE events SET metadata = ? WHERE sequence = ?", toJson(metadata, `The metadata of a ${event.type} event`), event.sequence);
  };
  const projections = createProjections(sql, transaction, clock, attachMetadata);
  const receipts = createReceipts(sql);
  const snapshots = createSnapshots(sql, clock);
  const clientSessions = createClientSessionTable(sql, requireTx);
  const pairings = createPairingTable(sql, requireTx);
  const providerTranscripts = createProviderTranscriptTable(sql, requireTx);
  const setupResults = createSetupResultTable(sql, requireTx);
  const skillSourceAttempts = createSkillSourceAttemptTable(sql, requireTx);
  const fileChanges = createFileChangeTable(sql, requireTx);

  // The stream's next version: above its last event, and above the last one its snapshot folds, which a compaction may have removed.
  const insertEvent = `
    INSERT INTO events (event_id, stream_kind, stream_id, stream_version, type, occurred_at,
                        command_id, causation_id, correlation_id, actor, payload, metadata)
    SELECT ?1, ?2, ?3,
           MAX(COALESCE(MAX(stream_version), 0),
               COALESCE((SELECT stream_version FROM snapshots WHERE stream_kind = ?2 AND stream_id = ?3), 0)) + 1,
           ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
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
      requireActor(options.actor);
      for (const input of inputs) {
        const unknown = Object.keys(input).filter((key) => !EVENT_INPUT_KEYS.has(key));
        if (unknown.length > 0) throw new TypeError(`A ${input.type} event to append has keys an event does not: ${unknown.join(", ")}.`);
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
        toJson(input.payload, `The payload of a ${input.type} event`, scrub),
        toJson(input.metadata ?? {}, `The metadata of a ${input.type} event`),
      ]);

      const events = transaction((): EventEnvelope[] => {
        const written = rows.map((row) => decodeEvent(sql.get<EventRow>(insertEvent, ...row) as EventRow));
        projecting = true;
        try {
          // The events as the projectors left them: with the metadata they attached, which is what readers get.
          return projections.catchUp(written);
        } finally {
          projecting = false;
        }
      });
      if (held) held.push(...events);
      else publish(events);
      return { events };
    },

    command(key, work) {
      requireActor(key.actor);
      return log.atomically((tx) => {
        const now = clock();
        const stored = receipts.read(key.actor, key.commandId, now);
        if (stored) return { replayed: true, receipt: stored };
        // Every event appended in this transaction, the work's own appends included.
        const appended = held ?? [];
        const before = appended.length;
        const outcome = work(tx);
        if (outcome.rejected !== undefined) {
          if (appended.length > before) {
            throw new TypeError(`A rejected command appends no events; command ${key.commandId} appended ${appended.length - before}.`);
          }
        } else if (outcome.events !== undefined && outcome.events.length > 0) {
          log.append(outcome.aggregate, outcome.events, { tx, actor: key.actor, commandId: key.commandId });
        }
        const events = appended.slice(before);
        const base = {
          actor: key.actor,
          commandId: key.commandId,
          stream: outcome.aggregate,
          sequence: log.head(),
          createdAt: now.toISOString(),
        };
        const receipt: StoredReceipt =
          outcome.rejected === undefined
            ? { ...base, status: "accepted", changed: events.length > 0 }
            : { ...base, status: "rejected", changed: false, error: outcome.rejected };
        receipts.write(receipt);
        return { replayed: false, receipt, events, result: outcome.rejected === undefined ? outcome.result : undefined };
      });
    },

    readStream(selector, afterSequence = 0, limit) {
      const { where, params } = selection(selector);
      return sql
        .all<EventRow>(
          // SQLite reads a negative LIMIT as none.
          `SELECT * FROM events WHERE ${where} AND sequence > ? ORDER BY sequence LIMIT ?`,
          ...params,
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
      // Queued before the callbacks run, delivered after them: a callback that appends, in an atomically of its own,
      // queues its events behind these, so every subscriber still hears sequences in ascending order.
      undelivered.push(...appended);
      const delivering = publishing;
      publishing = true;
      try {
        for (const callback of committed) {
          try {
            callback();
          } catch (error) {
            onSubscriberError(error);
          }
        }
      } finally {
        publishing = delivering;
      }
      publish([]);
      return result;
    },

    replayBound(selector, afterSequence) {
      const { where, params } = selection(selector);
      // The scan stops one event past the count bound, so an old, long stream costs no more than the bound.
      const row = sql.get<{ events: number; bytes: number }>(
        `SELECT COUNT(*) AS events,
                COALESCE(SUM(length(CAST(payload AS BLOB)) + length(CAST(metadata AS BLOB))), 0) AS bytes
         FROM (SELECT payload, metadata FROM events
               WHERE ${where} AND sequence > ?
               ORDER BY sequence LIMIT ?)`,
        ...params,
        afterSequence,
        REPLAY_BOUND.events + 1,
      ) ?? { events: 0, bytes: 0 };
      return {
        events: row.events,
        bytes: row.bytes,
        withinBound: row.events <= REPLAY_BOUND.events && row.bytes <= REPLAY_BOUND.bytes,
      };
    },

    replayStart(selector, afterSequence) {
      const snapshot = "id" in selector ? snapshots.read(selector) : null;
      return snapshot !== null && afterSequence < snapshot.sequence ? { after: snapshot.sequence, snapshot } : { after: afterSequence, snapshot: null };
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

    receipt: (actor, commandId) => receipts.read(actor, commandId, clock()),
    pruneReceipts: (now) => receipts.prune(now),
    purgeStream(stream, options) {
      requireTx(options.tx);
      const { changes } = sql.run("DELETE FROM events WHERE stream_kind = ? AND stream_id = ?", stream.kind, stream.id);
      snapshots.remove(stream);
      return changes;
    },
    compactStream(stream, compaction, options) {
      requireTx(options.tx);
      return snapshots.compact(stream, compaction);
    },
    readSnapshot: (stream) => snapshots.read(stream),
    clientSessions,
    pairings,
    providerTranscripts,
    setupResults,
    skillSourceAttempts,
    fileChanges,

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
