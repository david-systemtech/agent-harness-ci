import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventInput } from "./envelope.js";
import { openEventLog, type EventLog, type Projector } from "./event-log.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempDatabase = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-projectors-"));
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "environment.db");
};

const track = (log: EventLog): EventLog => {
  cleanups.push(() => log.close());
  return log;
};

const note = (text: string): EventInput => ({ type: "note.added", payload: { text } });

/**
 * A small counting projector: events per stream, and events per type. It
 * records the sequences it applied, and `weight` lets a test give it a bug.
 */
const countingProjector = (options: { weight?: () => number } = {}) => {
  const applied: number[] = [];
  const weight = options.weight ?? (() => 1);
  const projector: Projector = {
    name: "counts",
    tables: {
      stream_counts: `CREATE TABLE stream_counts (
        stream_kind TEXT NOT NULL, stream_id TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (stream_kind, stream_id))`,
      type_counts: "CREATE TABLE type_counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL)",
    },
    apply: (event, db) => {
      applied.push(event.sequence);
      db.run(
        `INSERT INTO stream_counts (stream_kind, stream_id, count) VALUES (?, ?, ?)
         ON CONFLICT (stream_kind, stream_id) DO UPDATE SET count = count + excluded.count`,
        event.streamKind,
        event.streamId,
        weight(),
      );
      db.run(
        `INSERT INTO type_counts (type, count) VALUES (?, 1)
         ON CONFLICT (type) DO UPDATE SET count = count + 1`,
        event.type,
      );
    },
  };
  return { projector, applied };
};

const readModel = (log: EventLog) => ({
  streams: log.read("SELECT stream_kind, stream_id, count FROM stream_counts ORDER BY stream_kind, stream_id"),
  types: log.read("SELECT type, count FROM type_counts ORDER BY type"),
});

const cursorOf = (log: EventLog, name: string) =>
  log.read<{ cursor: number }>("SELECT cursor FROM projection_state WHERE name = ?", name)[0]?.cursor;

const appendSome = (log: EventLog) => {
  log.append({ kind: "session", id: "a" }, [note("1"), note("2")], { actor: "system:test" });
  log.append({ kind: "session", id: "b" }, [{ type: "title.set", payload: { title: "B" } }], { actor: "system:test" });
  log.append({ kind: "group", id: "g" }, [note("3")], { actor: "system:test" });
};

describe("projectors", () => {
  it("apply each append's events in the append's transaction and move their cursor with it", () => {
    const { projector, applied } = countingProjector();
    const log = track(openEventLog({ path: ":memory:", projectors: [projector] }));
    appendSome(log);

    expect(applied).toEqual([1, 2, 3, 4]);
    expect(readModel(log).streams).toEqual([
      { stream_kind: "group", stream_id: "g", count: 1 },
      { stream_kind: "session", stream_id: "a", count: 2 },
      { stream_kind: "session", stream_id: "b", count: 1 },
    ]);
    expect(cursorOf(log, "counts")).toBe(4);
  });

  it("catch up from zero when registered on a log that already has events", () => {
    const log = track(openEventLog({ path: ":memory:" }));
    appendSome(log);
    const { projector, applied } = countingProjector();
    log.registerProjector(projector);

    expect(applied).toEqual([1, 2, 3, 4]);
    expect(cursorOf(log, "counts")).toBe(4);
  });

  it("catch up from their cursors before open returns", () => {
    const path = tempDatabase();
    const first = openEventLog({ path, projectors: [countingProjector().projector] });
    appendSome(first);
    first.close();

    const bare = openEventLog({ path });
    bare.append({ kind: "session", id: "a" }, [note("while the projector was away")], { actor: "system:test" });
    bare.close();

    const { projector, applied } = countingProjector();
    const reopened = track(openEventLog({ path, projectors: [projector] }));
    expect(applied).toEqual([5]);
    expect(readModel(reopened).streams).toContainEqual({ stream_kind: "session", stream_id: "a", count: 3 });
  });

  it("resume from their cursors after a restart without replaying events below them", () => {
    const path = tempDatabase();
    const first = openEventLog({ path, projectors: [countingProjector().projector] });
    appendSome(first);
    const before = readModel(first);
    first.close();

    const { projector, applied } = countingProjector();
    const reopened = track(openEventLog({ path, projectors: [projector] }));
    expect(applied).toEqual([]);
    expect(readModel(reopened)).toEqual(before);

    reopened.append({ kind: "session", id: "b" }, [note("new")], { actor: "system:test" });
    expect(applied).toEqual([5]);
    expect(cursorOf(reopened, "counts")).toBe(5);
  });

  it("are rebuilt by dropping their tables and replaying, giving the same read models", () => {
    const { projector, applied } = countingProjector();
    const log = track(openEventLog({ path: ":memory:", projectors: [projector] }));
    appendSome(log);
    log.append({ kind: "session", id: "a" }, [note("4")], { actor: "system:test" });
    const before = readModel(log);
    applied.length = 0;

    log.rebuildProjections();
    expect(applied).toEqual([1, 2, 3, 4, 5]);
    expect(readModel(log)).toEqual(before);
    expect(cursorOf(log, "counts")).toBe(5);
  });

  it("are rebuilt from the log alone, so a projection bug is fixed by a rebuild", () => {
    let weight = 2;
    const { projector } = countingProjector({ weight: () => weight });
    const log = track(openEventLog({ path: ":memory:", projectors: [projector] }));
    appendSome(log);
    expect(readModel(log).streams).toContainEqual({ stream_kind: "session", stream_id: "a", count: 4 });

    weight = 1;
    log.rebuildProjections();
    expect(readModel(log).streams).toContainEqual({ stream_kind: "session", stream_id: "a", count: 2 });
  });

  it("apply each later event once after a rebuild", () => {
    const { projector, applied } = countingProjector();
    const log = track(openEventLog({ path: ":memory:", projectors: [projector] }));
    appendSome(log);
    log.rebuildProjections();
    applied.length = 0;

    log.append({ kind: "session", id: "a" }, [note("after rebuild")], { actor: "system:test" });
    expect(applied).toEqual([5]);
    expect(readModel(log).streams).toContainEqual({ stream_kind: "session", stream_id: "a", count: 3 });
  });

  it("resume from the rebuilt cursor after a restart", () => {
    const path = tempDatabase();
    const first = openEventLog({ path, projectors: [countingProjector().projector] });
    appendSome(first);
    first.rebuildProjections();
    const before = readModel(first);
    first.close();

    const { projector, applied } = countingProjector();
    const reopened = track(openEventLog({ path, projectors: [projector] }));
    expect(applied).toEqual([]);
    expect(readModel(reopened)).toEqual(before);
    expect(cursorOf(reopened, "counts")).toBe(4);
  });

  it("leave the events, receipts and snapshots alone when rebuilt", () => {
    const log = track(openEventLog({ path: ":memory:", projectors: [countingProjector().projector] }));
    log.command({ actor: "client_session:1", commandId: "c-1" }, () => ({ aggregate: { kind: "session", id: "a" }, result: null, events: [note("1")] }));
    log.writeSnapshot({ kind: "session", id: "a" }, { sequence: 1, payload: { n: 1 } });

    log.rebuildProjections();
    expect(log.readStream({ kind: "session", id: "a" })).toHaveLength(1);
    expect(log.receipt("client_session:1", "c-1")).not.toBeNull();
    expect(log.readSnapshot({ kind: "session", id: "a" })).not.toBeNull();
  });

  it("are refused a name already registered", () => {
    const log = track(openEventLog({ path: ":memory:", projectors: [countingProjector().projector] }));
    expect(() => log.registerProjector({ ...countingProjector().projector, tables: {} })).toThrow(/already/);
  });

  it("are refused a table another projector owns, or one of the log's own", () => {
    const log = track(openEventLog({ path: ":memory:", projectors: [countingProjector().projector] }));
    const claiming = (table: string): Projector => ({
      name: `claims-${table}`,
      tables: { [table]: `CREATE TABLE ${table} (x INTEGER)` },
      apply: () => {},
    });
    expect(() => log.registerProjector(claiming("type_counts"))).toThrow(/owned/);
    expect(() => log.registerProjector(claiming("events"))).toThrow(/owned/);
    // SQLite ignores ASCII case in table names, so a case variant is the same table.
    expect(() => log.registerProjector(claiming("Events"))).toThrow(/owned/);
    expect(() => log.registerProjector(claiming("TYPE_COUNTS"))).toThrow(/owned/);
    expect(() => log.registerProjector(claiming("SQLITE_master"))).toThrow(/not a table name/);
    expect(log.readStream({ kind: "session", id: "any" })).toEqual([]);
  });

  it("are rebuilt from the log when a declared table was made by other statements: a column added since, an index dropped", () => {
    const path = tempDatabase();
    const older = countingProjector();
    const first = openEventLog({
      path,
      projectors: [{ ...older.projector, tables: { ...older.projector.tables, type_counts: "CREATE TABLE type_counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL)" } }],
    });
    appendSome(first);
    first.close();

    const { projector, applied } = countingProjector();
    const newer: Projector = {
      ...projector,
      tables: {
        ...projector.tables,
        type_counts: `CREATE TABLE type_counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL, note TEXT);
          CREATE INDEX type_counts_by_count ON type_counts (count)`,
      },
    };
    const reopened = track(openEventLog({ path, projectors: [newer] }));
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(reopened.read("SELECT note FROM type_counts WHERE type = 'note.added'")).toEqual([{ note: null }]);
    expect(readModel(reopened).types).toEqual([
      { type: "note.added", count: 3 },
      { type: "title.set", count: 1 },
    ]);
    reopened.close();

    // The same statements again, however spaced or cased, resume from the cursor; dropping the index rebuilds once more.
    const again = countingProjector();
    const respaced = (newer.tables["stream_counts"] as string).replace(/\s+/g, "  ").replace("CREATE TABLE", "create table if not exists");
    track(openEventLog({ path, projectors: [{ ...newer, apply: again.projector.apply, tables: { ...newer.tables, stream_counts: respaced } }] })).close();
    expect(again.applied).toEqual([]);
    const withoutIndex = countingProjector();
    const noIndex = "CREATE TABLE type_counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL, note TEXT)";
    track(openEventLog({ path, projectors: [{ ...withoutIndex.projector, tables: { ...newer.tables, type_counts: noIndex } }] }));
    expect(withoutIndex.applied).toEqual([1, 2, 3, 4]);
  });

  it("accept a declared table whose statement creates it under another case, as SQLite does", () => {
    const log = track(openEventLog({ path: ":memory:" }));
    log.registerProjector({ name: "cased", tables: { Counts: "CREATE TABLE counts (x INTEGER)" }, apply: () => {} });
    expect(log.read("SELECT name FROM sqlite_schema WHERE lower(name) = 'counts'")).toEqual([{ name: "counts" }]);
  });

  it("are refused a declared table their statements do not create", () => {
    const log = track(openEventLog({ path: ":memory:" }));
    expect(() =>
      log.registerProjector({
        name: "mismatch",
        tables: { declared: "CREATE TABLE something_else (x INTEGER)" },
        apply: () => {},
      }),
    ).toThrow(/declared/);
    expect(log.read("SELECT name FROM sqlite_schema WHERE name = 'something_else'")).toEqual([]);
  });
});

/**
 * A projector that attaches `{ [key]: <what it saw> }` to every event it
 * applies, the way the session list attaches its patch: a note's text, uppercased.
 */
const attaching = (name: string, key: string): Projector => ({
  name,
  tables: {},
  apply: (event, _db, context) => {
    context.attachMetadata({ [key]: String(event.payload["text"]).toUpperCase() });
  },
});

describe("a projector's metadata", () => {
  it("is attached to the event being appended in the append's transaction: returned, stored, read back and published", () => {
    const log = track(openEventLog({ path: ":memory:", projectors: [attaching("shout", "shouted")] }));
    const heard: unknown[] = [];
    log.subscribe((event) => heard.push(event.metadata));
    const { events } = log.append({ kind: "session", id: "a" }, [{ ...note("hi"), metadata: { from: "test" } }, note("there")], {
      actor: "system:test",
    });
    expect(events.map((event) => event.metadata)).toEqual([{ from: "test", shouted: "HI" }, { shouted: "THERE" }]);
    expect(log.readStream({ kind: "session", id: "a" }).map((event) => event.metadata)).toEqual([
      { from: "test", shouted: "HI" },
      { shouted: "THERE" },
    ]);
    expect(heard).toEqual([{ from: "test", shouted: "HI" }, { shouted: "THERE" }]);
  });

  it("is attached to a command's events too, and the receipt's events carry it", () => {
    const log = track(openEventLog({ path: ":memory:", projectors: [attaching("shout", "shouted")] }));
    const run = log.command({ actor: "client_session:1", commandId: "c-1" }, () => ({
      aggregate: { kind: "session", id: "a" },
      result: null,
      events: [note("cmd")],
    }));
    expect(run.replayed === false && run.events.map((event) => event.metadata)).toEqual([{ shouted: "CMD" }]);
  });

  it("is not written again when the log is replayed into the projector: a rebuild or a late registration leaves history as it was", () => {
    const log = track(openEventLog({ path: ":memory:" }));
    log.append({ kind: "session", id: "a" }, [note("before")], { actor: "system:test" });
    log.registerProjector(attaching("shout", "shouted"));
    log.append({ kind: "session", id: "a" }, [note("after")], { actor: "system:test" });
    log.rebuildProjections();
    expect(log.readStream({ kind: "session", id: "a" }).map((event) => event.metadata)).toEqual([{}, { shouted: "AFTER" }]);
  });

  it("may not overwrite what the appender or another projector attached: the append fails and nothing commits", () => {
    const log = track(openEventLog({ path: ":memory:", projectors: [attaching("shout", "shouted")] }));
    expect(() =>
      log.append({ kind: "session", id: "a" }, [{ ...note("x"), metadata: { shouted: "mine" } }], { actor: "system:test" }),
    ).toThrow(/shouted/);
    log.registerProjector(attaching("shout-again", "shouted"));
    expect(() => log.append({ kind: "session", id: "a" }, [note("y")], { actor: "system:test" })).toThrow(/shouted/);
    expect(log.readStream({ kind: "session", id: "a" })).toEqual([]);
    expect(log.head()).toBe(0);
  });
});
