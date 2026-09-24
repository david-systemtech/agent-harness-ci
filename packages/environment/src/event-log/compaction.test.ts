import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventInput, StreamRef } from "./envelope.js";
import { openEventLog, type EventLog, type Tx } from "./event-log.js";
import { loadSqlite } from "./sqlite.js";

/**
 * Compacting a stream at the lower seam (env spec, "The event log":
 * compaction; "Testing Decisions": compaction of an old session into a
 * snapshot): the log's side of it, whatever the stream. A compaction
 * writes the snapshot that stands in, for replay, for the stream's events
 * at or below its sequence, and removes the events it is told to, in the
 * transaction open now. The session's rule (which events, when) is
 * `sessions/compaction.ts`'s, tested beside it.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const track = (log: EventLog): EventLog => {
  cleanups.push(() => log.close());
  return log;
};

const AT = "2026-09-24T10:00:00.000Z";
const memoryLog = (): EventLog => track(openEventLog({ path: ":memory:", clock: () => new Date(AT) }));

const s1: StreamRef = { kind: "session", id: "s1" };
const s2: StreamRef = { kind: "session", id: "s2" };
const actor = "system:test";
const note = (text: string): EventInput => ({ type: "note.added", payload: { text } });
const kept = (text: string): EventInput => ({ type: "note.kept", payload: { text } });

/** Appends `inputs` to `stream` and answers their sequences. */
const append = (log: EventLog, stream: StreamRef, inputs: EventInput[]): number[] =>
  log.append(stream, inputs, { actor }).events.map((event) => event.sequence);

const compact = (log: EventLog, stream: StreamRef, sequence: number, remove: number[], payload: unknown = { folded: sequence }): number =>
  log.atomically((tx) => log.compactStream(stream, { sequence, payload, remove }, { tx }));

describe("compacting a stream", () => {
  it("removes the events named, writes the snapshot at the sequence it folds to, and leaves every other event and stream alone", () => {
    const log = memoryLog();
    const [one, two, three, four] = append(log, s1, [note("one"), kept("two"), note("three"), kept("four")]) as [number, number, number, number];
    const others = log.append(s2, [note("other")], { actor }).events;
    const head = log.head();

    expect(compact(log, s1, four, [one, three], { notes: ["one", "three"] })).toBe(2);

    expect(log.readStream(s1).map((event) => [event.sequence, event.streamVersion, event.type])).toEqual([
      [two, 2, "note.kept"],
      [four, 4, "note.kept"],
    ]);
    expect(log.readStream(s2)).toEqual(others);
    expect(log.readSnapshot(s1)).toEqual({
      stream: s1,
      sequence: four,
      streamVersion: 4,
      folded: 2,
      payload: { notes: ["one", "three"] },
      createdAt: AT,
    });
    // Nothing is appended and no sequence is given back.
    expect(log.head()).toBe(head);
  });

  it("keeps the stream's versions rising when the events it removes were the stream's last: the next is numbered after them", () => {
    const log = memoryLog();
    const [one, , three] = append(log, s1, [kept("one"), note("two"), note("three")]) as [number, number, number];

    compact(log, s1, three, [one + 1, three]);

    const [next] = log.append(s1, [note("after")], { actor }).events;
    expect(next).toMatchObject({ sequence: three + 1, streamVersion: 4 });
    expect(log.readStream(s1).map((event) => event.streamVersion)).toEqual([1, 4]);
  });

  it("folds again later from where the snapshot stands: the new one replaces it, its count adding up and its version never lowered", () => {
    const log = memoryLog();
    const [one, two] = append(log, s1, [note("one"), note("two")]) as [number, number];
    compact(log, s1, two, [one, two]);
    const [three, four] = append(log, s1, [note("three"), kept("four")]) as [number, number];

    expect(compact(log, s1, four, [three], { again: true })).toBe(1);

    expect(log.readSnapshot(s1)).toMatchObject({ sequence: four, streamVersion: 4, folded: 3, payload: { again: true } });
    expect(log.readStream(s1).map((event) => [event.sequence, event.streamVersion])).toEqual([[four, 4]]);
  });

  it("refuses an event that is not the stream's, or is past the sequence the snapshot folds to, and removes nothing", () => {
    const log = memoryLog();
    const [one, two, three] = append(log, s1, [note("one"), note("two"), note("three")]) as [number, number, number];
    const [other] = append(log, s2, [note("other")]) as [number];

    expect(() => compact(log, s1, two, [one, other])).toThrow(/not.*s1/);
    expect(() => compact(log, s1, two, [one, three])).toThrow(/not.*s1/);
    expect(() => compact(log, s1, two, [one, 999])).toThrow(/not.*s1/);
    expect(log.readStream(s1).map((event) => event.sequence)).toEqual([one, two, three]);
    expect(log.readStream(s2).map((event) => event.sequence)).toEqual([other]);
    expect(log.readSnapshot(s1)).toBeNull();
  });

  it("refuses to fold to a sequence below the snapshot the stream has, or past its last event", () => {
    const log = memoryLog();
    const [one, two, three] = append(log, s1, [note("one"), note("two"), note("three")]) as [number, number, number];
    compact(log, s1, two, [one]);

    expect(() => compact(log, s1, one, [])).toThrow(/below/);
    expect(() => compact(log, s1, three + 1, [])).toThrow(/last event/);
    expect(log.readSnapshot(s1)).toMatchObject({ sequence: two, folded: 1 });
  });

  it("commits with the atomically it is part of, and not at all when that rolls back", () => {
    const log = memoryLog();
    const [one, two] = append(log, s1, [note("one"), note("two")]) as [number, number];
    expect(() =>
      log.atomically((tx) => {
        log.compactStream(s1, { sequence: two, payload: {}, remove: [one] }, { tx });
        throw new Error("changed my mind");
      }),
    ).toThrow("changed my mind");
    expect(log.readStream(s1).map((event) => event.sequence)).toEqual([one, two]);
    expect(log.readSnapshot(s1)).toBeNull();
  });

  it("is refused outside the atomically open now, and to a projector", () => {
    const log = memoryLog();
    const [one] = append(log, s1, [note("one")]) as [number];
    let stale: Tx | undefined;
    log.atomically((tx) => (stale = tx));
    const old = stale as Tx;
    expect(() => log.compactStream(s1, { sequence: one, payload: {}, remove: [one] }, { tx: old })).toThrow(/transaction/);
    log.registerProjector({
      name: "sneaky",
      tables: {},
      apply: (event) => void (event.type === "note.compact" && log.compactStream(s1, { sequence: one, payload: {}, remove: [one] }, { tx: old })),
    });
    expect(() => log.append(s2, [{ type: "note.compact", payload: {} }], { actor })).toThrow(/projector/);
    expect(log.readStream(s1)).toHaveLength(1);
  });

  it("survives a restart, snapshot and version floor both", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-compaction-"));
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "environment.db");
    const first = openEventLog({ path, clock: () => new Date(AT) });
    const [one, two] = append(first, s1, [kept("one"), note("two")]) as [number, number];
    compact(first, s1, two, [two]);
    first.close();

    const second = track(openEventLog({ path }));
    expect(second.readSnapshot(s1)).toMatchObject({ sequence: two, streamVersion: 2, folded: 1 });
    expect(second.append(s1, [note("three")], { actor }).events[0]).toMatchObject({ streamVersion: 3 });
    expect(second.readStream(s1).map((event) => event.sequence)).toEqual([one, two + 1]);
  });

  it("adds the version floor and the count to a snapshots table an older schema made, as zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-compaction-"));
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "environment.db");
    const old = openEventLog({ path, clock: () => new Date(AT) });
    old.writeSnapshot(s1, { sequence: 3, payload: { older: true } });
    old.close();
    // Back to the schema before the columns, the row still in it.
    const raw = new (loadSqlite().DatabaseSync)(path);
    raw.exec("ALTER TABLE snapshots DROP COLUMN stream_version; ALTER TABLE snapshots DROP COLUMN folded; PRAGMA user_version = 4;");
    raw.close();

    expect(track(openEventLog({ path })).readSnapshot(s1)).toMatchObject({ sequence: 3, streamVersion: 0, folded: 0, payload: { older: true } });
  });
});

describe("where replay starts", () => {
  it("is after the cursor for a stream with no snapshot, and for a selection of many streams", () => {
    const log = memoryLog();
    append(log, s1, [note("one"), note("two")]);
    expect(log.replayStart(s1, 0)).toEqual({ after: 0, snapshot: null });
    compact(log, s1, 2, [1]);
    expect(log.replayStart({ kinds: ["session"] }, 0)).toEqual({ after: 0, snapshot: null });
  });

  it("is after the snapshot, which is sent first, for a cursor below it; after the cursor for one at or above it", () => {
    const log = memoryLog();
    const [one, two, three] = append(log, s1, [note("one"), kept("two"), note("three")]) as [number, number, number];
    compact(log, s1, two, [one]);
    const snapshot = log.readSnapshot(s1);

    expect(log.replayStart(s1, 0)).toEqual({ after: two, snapshot });
    expect(log.replayStart(s1, one)).toEqual({ after: two, snapshot });
    expect(log.replayStart(s1, two)).toEqual({ after: two, snapshot: null });
    expect(log.replayStart(s1, three)).toEqual({ after: three, snapshot: null });
    // The bound is then measured from where replay starts: the one event after the snapshot.
    expect(log.replayBound(s1, log.replayStart(s1, 0).after)).toMatchObject({ events: 1 });
  });
});

describe("purging a compacted stream", () => {
  it("removes its snapshot with its events, so the tombstone is its version 1 again", () => {
    const log = memoryLog();
    const [one, two] = append(log, s1, [note("one"), note("two")]) as [number, number];
    compact(log, s1, two, [one, two]);

    const tombstone = log.atomically((tx) => {
      log.purgeStream(s1, { tx });
      return log.append(s1, [{ type: "stream.purged", payload: {} }], { actor, tx }).events[0];
    });

    expect(log.readSnapshot(s1)).toBeNull();
    expect(tombstone).toMatchObject({ streamVersion: 1 });
    expect(log.replayStart(s1, 0)).toEqual({ after: 0, snapshot: null });
  });
});
