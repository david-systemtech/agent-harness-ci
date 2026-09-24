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
  log.append({ kind: "session", id: "a" }, [note("1"), note("2")], { actor: "test" });
  log.append({ kind: "session", id: "b" }, [{ type: "title.set", payload: "B" }], { actor: "test" });
  log.append({ kind: "group", id: "g" }, [note("3")], { actor: "test" });
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
    bare.append({ kind: "session", id: "a" }, [note("while the projector was away")], { actor: "test" });
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

    reopened.append({ kind: "session", id: "b" }, [note("new")], { actor: "test" });
    expect(applied).toEqual([5]);
    expect(cursorOf(reopened, "counts")).toBe(5);
  });

  it("are rebuilt by dropping their tables and replaying, giving the same read models", () => {
    const { projector, applied } = countingProjector();
    const log = track(openEventLog({ path: ":memory:", projectors: [projector] }));
    appendSome(log);
    log.append({ kind: "session", id: "a" }, [note("4")], { actor: "test" });
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

    log.append({ kind: "session", id: "a" }, [note("after rebuild")], { actor: "test" });
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
    log.append({ kind: "session", id: "a" }, [note("1")], {
      actor: "client:1",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });
    log.writeSnapshot({ kind: "session", id: "a" }, { sequence: 1, payload: { n: 1 } });

    log.rebuildProjections();
    expect(log.readStream({ kind: "session", id: "a" })).toHaveLength(1);
    expect(log.receipt("client:1", "c-1")).not.toBeNull();
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
