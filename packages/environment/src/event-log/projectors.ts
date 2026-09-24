import { decodeEvent, type EventRow, type Sql, type SqlValue, type Transaction } from "./database.js";
import type { EventEnvelope, JsonObject } from "./envelope.js";
import { logTables } from "./migrations.js";

/** Events read per page when a projector catches up. */
const CATCH_UP_PAGE = 500;

/** A statement as compared with the one SQLite keeps: trimmed, white space collapsed, case folded, `IF NOT EXISTS` dropped. */
const normalisedStatement = (statement: string): string =>
  statement
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^create (unique )?(table|index) if not exists /, "create $1$2 ");

/** A name a projector may give a table: a plain SQL identifier, never SQLite's own. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The narrow handle a projector writes its tables through. */
export interface ProjectionDb {
  run(sql: string, ...params: readonly SqlValue[]): void;
  get<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row | undefined;
  all<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
}

/**
 * What a projector is handed beside the event it applies. `attachMetadata`
 * adds entries to the metadata of the event being appended, in the append's
 * transaction, before anything is committed or published: the session list
 * writes its summary patch this way. When the log is replayed into a
 * projector (its registration catching up, a rebuild), the events are
 * history and it does nothing. An entry may not replace one the appender or
 * another projector set: the append throws and nothing commits.
 */
export interface ProjectionContext {
  attachMetadata(entries: JsonObject): void;
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
  apply(event: EventEnvelope, db: ProjectionDb, context: ProjectionContext): void;
}

/**
 * The registered projectors, their tables and their cursors in
 * `projection_state`. `catchUp` runs inside the caller's transaction;
 * `register` and `rebuild` open their own, or join the `atomically` open
 * now (a command's).
 */
export const createProjections = (
  sql: Sql,
  transaction: Transaction,
  clock: () => Date,
  /** The log's write of an appended event's merged metadata to its row. */
  attachMetadata: (event: EventEnvelope, metadata: JsonObject) => void,
) => {
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

  /**
   * Whether the table's statements in the database are the ones declared: its
   * `CREATE TABLE` and any index on it, as SQLite keeps them (`sqlite_schema.sql`),
   * against the declared statements, both with white space collapsed, case
   * folded and `IF NOT EXISTS` dropped, as SQLite drops it.
   */
  const hasDeclaredShape = (table: string, statements: string): boolean => {
    const held = sql
      .all<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE lower(tbl_name) = lower(?) AND sql IS NOT NULL ORDER BY rowid", table)
      .map((row) => normalisedStatement(row.sql));
    const declared = statements.split(";").map(normalisedStatement).filter((statement) => statement !== "");
    return held.length === declared.length && held.every((statement, i) => statement === declared[i]);
  };

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

  /** Replayed history: what a projector attaches to it is dropped. */
  const replaying: ProjectionContext = { attachMetadata: () => undefined };

  /**
   * The context for applying `event`: when it is one of the events being
   * appended now, what the projector attaches is merged into `attached`, by
   * sequence, refusing any key the event or an earlier projector already holds.
   */
  const contextFor = (projector: Projector, event: EventEnvelope, attached: Map<number, JsonObject> | undefined): ProjectionContext => {
    if (attached === undefined || !attached.has(event.sequence)) return replaying;
    return {
      attachMetadata(entries) {
        const metadata = attached.get(event.sequence) as JsonObject;
        for (const key of Object.keys(entries)) {
          if (Object.hasOwn(metadata, key)) {
            throw new Error(`Projector ${projector.name} attached metadata ${key} to a ${event.type} event, which already holds it.`);
          }
        }
        attached.set(event.sequence, { ...metadata, ...entries });
      },
    };
  };

  /**
   * Applies every event above the projector's cursor and moves the cursor to
   * the last. `justWritten` are the events the current append wrote: when they
   * follow the cursor directly they are applied as they are, rather than read
   * back and decoded again. `attached` holds their metadata by sequence, and
   * gathers what the projector attaches to them.
   */
  const catchUpOne = (projector: Projector, justWritten: readonly EventEnvelope[] = [], attached?: Map<number, JsonObject>): void => {
    const start = cursorOf(projector.name) ?? 0;
    let cursor = start;
    if (justWritten[0]?.sequence === cursor + 1) {
      for (const event of justWritten) {
        projector.apply(event, db, contextFor(projector, event, attached));
        cursor = event.sequence;
      }
    } else {
      for (;;) {
        const rows = sql.all<EventRow>(
          `SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ${CATCH_UP_PAGE}`,
          cursor,
        );
        for (const row of rows) {
          const event = decodeEvent(row);
          projector.apply(event, db, contextFor(projector, event, attached));
          cursor = row.sequence;
        }
        if (rows.length < CATCH_UP_PAGE) break;
      }
    }
    if (cursor !== start) setCursor(projector.name, cursor);
  };

  return {
    /**
     * Brings every projector up to the log's end, inside the caller's
     * transaction, and returns `justWritten` as they are now: each with the
     * metadata the projectors attached to it, which the log writes to its row.
     */
    catchUp(justWritten: readonly EventEnvelope[]): EventEnvelope[] {
      const attached = new Map(justWritten.map((event) => [event.sequence, event.metadata]));
      for (const projector of projectors) catchUpOne(projector, justWritten, attached);
      return justWritten.map((event) => {
        const metadata = attached.get(event.sequence) as JsonObject;
        if (metadata === event.metadata) return event;
        attachMetadata(event, metadata);
        return { ...event, metadata };
      });
    },

    /**
     * Creates the projector's tables if needed and catches it up from its
     * cursor; with no cursor, or a declared table missing or made by other
     * statements than those declared, it rebuilds the projector from the log.
     */
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
        // No cursor, a declared table missing, or one made by other statements (an older version's, without a
        // column added since): the read model cannot be trusted, so it starts again from zero, from the log.
        const mustReset =
          cursorOf(projector.name) === undefined ||
          Object.entries(projector.tables).some(([table, statements]) => !tableExists(table) || !hasDeclaredShape(table, statements));
        if (mustReset) reset(projector);
        catchUpOne(projector);
      });
      projectors.push(projector);
      for (const table of Object.keys(projector.tables)) tableOwners.set(table.toLowerCase(), projector.name);
    },

    /** Drops every registered projector's tables, recreates them and replays the whole log, in one transaction; returns their names. */
    rebuild(): string[] {
      transaction(() => {
        for (const projector of projectors) reset(projector);
        for (const projector of projectors) catchUpOne(projector);
      });
      return projectors.map((projector) => projector.name);
    },
  };
};
