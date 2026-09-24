import { decodeEvent, type EventRow, type Sql, type SqlValue, type Transaction } from "./database.js";
import type { EventEnvelope } from "./envelope.js";
import { logTables } from "./migrations.js";

/** Events read per page when a projector catches up. */
const CATCH_UP_PAGE = 500;

/** A name a projector may give a table: a plain SQL identifier, never SQLite's own. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The narrow handle a projector writes its tables through. */
export interface ProjectionDb {
  run(sql: string, ...params: readonly SqlValue[]): void;
  get<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row | undefined;
  all<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
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

/**
 * The registered projectors, their tables and their cursors in
 * `projection_state`. `catchUp` runs inside the caller's transaction;
 * `register` and `rebuild` open their own.
 */
export const createProjections = (sql: Sql, transaction: Transaction, clock: () => Date) => {
  const projectors: Projector[] = [];
  /** Every table a projector owns, to the projector that owns it. */
  const tableOwners = new Map<string, string>();

  const db: ProjectionDb = {
    run: (text, ...params) => {
      sql.run(text, ...params);
    },
    get: <Row>(text: string, ...params: readonly SqlValue[]) => sql.get<Row>(text, ...params),
    all: <Row>(text: string, ...params: readonly SqlValue[]) => sql.all<Row>(text, ...params),
  };

  const cursorOf = (name: string): number | undefined =>
    sql.get<{ cursor: number }>("SELECT cursor FROM projection_state WHERE name = ?", name)?.cursor;

  const setCursor = (name: string, cursor: number): void => {
    sql.run(
      `INSERT INTO projection_state (name, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      name,
      cursor,
      clock().toISOString(),
    );
  };

  const tableExists = (name: string): boolean =>
    sql.get("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)", name) !== undefined;

  /** Drops the projector's tables, creates them again and puts its cursor back to zero. */
  const reset = (projector: Projector): void => {
    for (const table of Object.keys(projector.tables).reverse()) sql.exec(`DROP TABLE IF EXISTS "${table}"`);
    for (const [table, statements] of Object.entries(projector.tables)) {
      sql.exec(statements);
      if (!tableExists(table)) {
        throw new Error(`Projector ${projector.name} declared table ${table}, but its statements did not create it.`);
      }
    }
    setCursor(projector.name, 0);
  };

  /**
   * Applies every event above the projector's cursor and moves the cursor to
   * the last. `justWritten` are the events the current append wrote: when they
   * follow the cursor directly they are applied as they are, rather than read
   * back and decoded again.
   */
  const catchUpOne = (projector: Projector, justWritten: readonly EventEnvelope[] = []): void => {
    const start = cursorOf(projector.name) ?? 0;
    let cursor = start;
    if (justWritten[0]?.sequence === cursor + 1) {
      for (const event of justWritten) {
        projector.apply(event, db);
        cursor = event.sequence;
      }
    } else {
      for (;;) {
        const rows = sql.all<EventRow>(
          `SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ${CATCH_UP_PAGE}`,
          cursor,
        );
        for (const row of rows) {
          projector.apply(decodeEvent(row), db);
          cursor = row.sequence;
        }
        if (rows.length < CATCH_UP_PAGE) break;
      }
    }
    if (cursor !== start) setCursor(projector.name, cursor);
  };

  return {
    /** Brings every projector up to the log's end, inside the caller's transaction. */
    catchUp(justWritten: readonly EventEnvelope[]): void {
      for (const projector of projectors) catchUpOne(projector, justWritten);
    },

    /** Creates the projector's tables if needed and catches it up from its cursor. */
    register(projector: Projector): void {
      if (projectors.some((p) => p.name === projector.name)) {
        throw new Error(`A projector named ${projector.name} is already registered.`);
      }
      // SQLite resolves table names ignoring ASCII case, so every ownership check compares lowercased names.
      for (const table of Object.keys(projector.tables)) {
        const name = table.toLowerCase();
        if (!TABLE_NAME.test(table) || name.startsWith("sqlite_")) {
          throw new Error(`Projector ${projector.name} declared ${JSON.stringify(table)}, which is not a table name.`);
        }
        if (logTables().has(name)) throw new Error(`Table ${table} is owned by the event log itself.`);
        const owner = tableOwners.get(name);
        if (owner) throw new Error(`Table ${table} is owned by projector ${owner}.`);
      }
      transaction(() => {
        // No cursor, or a declared table missing: the read model cannot be trusted, so it starts again from zero.
        const mustReset =
          cursorOf(projector.name) === undefined || Object.keys(projector.tables).some((table) => !tableExists(table));
        if (mustReset) reset(projector);
        catchUpOne(projector);
      });
      projectors.push(projector);
      for (const table of Object.keys(projector.tables)) tableOwners.set(table.toLowerCase(), projector.name);
    },

    /** Drops every registered projector's tables, recreates them and replays the whole log, in one transaction. */
    rebuild(): void {
      transaction(() => {
        for (const projector of projectors) reset(projector);
        for (const projector of projectors) catchUpOne(projector);
      });
    },
  };
};
