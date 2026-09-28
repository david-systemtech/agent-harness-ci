import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { EventEnvelope, JsonObject } from "./envelope.js";

/** A value SQLite takes as a parameter; the package's own, so no `node:sqlite` type is in its public API. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** The narrow statement handle the store's parts share: prepared once per SQL text, then reused. */
export interface Sql {
  run(sql: string, ...params: readonly SqlValue[]): { changes: number };
  get<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row | undefined;
  all<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
  /** Runs statements without parameters, several at once: DDL and pragmas. */
  exec(sql: string): void;
}

/** Runs `work` in one write transaction, committing on return and rolling back on throw. */
export type Transaction = <T>(work: () => T) => T;

export const createSql = (db: DatabaseSync): Sql & { clear(): void } => {
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  return {
    run: (sql, ...params) => ({ changes: Number(statement(sql).run(...params).changes) }),
    get: <Row>(sql: string, ...params: readonly SqlValue[]) =>
      statement(sql).get(...params) as unknown as Row | undefined,
    all: <Row>(sql: string, ...params: readonly SqlValue[]) => statement(sql).all(...params) as unknown as Row[],
    exec: (sql) => db.exec(sql),
    clear: () => statements.clear(),
  };
};

/** One `events` row as SQLite returns it. */
export interface EventRow {
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

export const decodeEvent = (row: EventRow): EventEnvelope => ({
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
  payload: JSON.parse(row.payload) as JsonObject,
  metadata: JSON.parse(row.metadata) as JsonObject,
});

/** A string as it is: `toJson`'s preset for the strings it writes. */
const asItIs = (text: string): string => text;

/**
 * `value` as JSON text; throws for a value JSON cannot hold anywhere in it: `undefined`, a function or a
 * symbol (JSON.stringify would silently drop or null them), a non-finite number (it would write `null`),
 * a bigint or a cycle. What is read back is then always what was appended. Every string in it, an
 * object's keys included, is written as `strings` answers it: the log's append passes the scrub registry.
 */
export const toJson = (value: unknown, what: string, strings: (text: string) => string = asItIs): string => {
  const json = JSON.stringify(value, (key, v: unknown) => {
    const unholdable =
      (typeof v === "number" && !Number.isFinite(v)) ||
      (v === undefined && key !== "") ||
      typeof v === "function" ||
      typeof v === "symbol";
    if (unholdable) {
      throw new TypeError(`${what} holds ${String(v)}${key ? ` at "${key}"` : ""}, which JSON cannot hold.`);
    }
    if (typeof v === "string") return strings(v);
    // An object whose keys change is written as a copy under the new keys; JSON.stringify then visits the copy's values.
    if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).some((name) => strings(name) !== name)) {
      return Object.fromEntries(Object.entries(v).map(([name, entry]) => [strings(name), entry]));
    }
    return v;
  });
  if (json === undefined) throw new TypeError(`${what} is not a JSON value.`);
  return json;
};
