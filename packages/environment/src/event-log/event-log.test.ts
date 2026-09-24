import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventInput } from "./envelope.js";
import { openEventLog, REPLAY_BOUND, type EventLog, type Projector } from "./event-log.js";
import { MIGRATIONS } from "./migrations.js";
import { loadSqlite } from "./sqlite.js";

const DAY = 24 * 60 * 60 * 1000;

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const track = (log: EventLog): EventLog => {
  cleanups.push(() => log.close());
  return log;
};

const memoryLog = (options: Omit<Parameters<typeof openEventLog>[0], "path"> = {}): EventLog =>
  track(openEventLog({ path: ":memory:", ...options }));

/** A database file in a fresh temporary directory, removed after the test. */
const tempDatabase = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-event-log-"));
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "environment.db");
};

/** A clock the test moves by hand. */
const manualClock = (start: string) => {
  let now = new Date(start);
  return {
    clock: () => now,
    set: (iso: string) => {
      now = new Date(iso);
    },
  };
};

const note = (text: string): EventInput => ({ type: "note.added", payload: { text } });

/** A projector that fails on one event type, to force a rollback. */
const failingOn = (type: string): Projector => ({
  name: "fails",
  tables: { fails_seen: "CREATE TABLE fails_seen (sequence INTEGER PRIMARY KEY)" },
  apply: (event, db) => {
    if (event.type === type) throw new Error(`projector refused ${type}`);
    db.run("INSERT INTO fails_seen (sequence) VALUES (?)", event.sequence);
  },
});

describe("opening the event log", () => {
  it("opens a database file in WAL mode with foreign keys on", () => {
    const log = track(openEventLog({ path: tempDatabase() }));
    expect(log.query("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(log.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("turns foreign keys on for an in-memory database too", () => {
    expect(memoryLog().query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("creates its tables by applying the migrations on open", () => {
    const log = memoryLog();
    const tables = log
      .query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((t) => t.name);
    expect(tables.sort()).toEqual(["command_receipts", "events", "projection_state", "snapshots"]);
    expect(log.query("PRAGMA user_version")).toEqual([{ user_version: MIGRATIONS.length }]);
  });

  it("applies no migration twice when a database file is reopened", () => {
    const path = tempDatabase();
    const first = openEventLog({ path });
    first.append("session", "s1", [note("kept")], { actor: "test" });
    first.close();

    const second = track(openEventLog({ path }));
    expect(second.readStream("session", "s1").map((e) => e.payload)).toEqual([{ text: "kept" }]);
    expect(second.query("PRAGMA user_version")).toEqual([{ user_version: MIGRATIONS.length }]);
  });

  it("refuses a database written by a newer schema", () => {
    const path = tempDatabase();
    openEventLog({ path }).close();
    const raw = new (loadSqlite().DatabaseSync)(path);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    raw.close();

    expect(() => openEventLog({ path })).toThrow(/newer/);
  });
});

describe("appending", () => {
  it("gives each event the next global sequence and the next version of its own stream", () => {
    const log = memoryLog();
    log.append("session", "a", [note("a1"), note("a2")], { actor: "test" });
    log.append("session", "b", [note("b1")], { actor: "test" });
    log.append("session", "a", [note("a3")], { actor: "test" });
    log.append("group", "a", [note("group a1")], { actor: "test" });

    const versions = (kind: string, id: string) =>
      log.readStream(kind, id).map((e) => [e.sequence, e.streamVersion]);
    expect(versions("session", "a")).toEqual([
      [1, 1],
      [2, 2],
      [4, 3],
    ]);
    expect(versions("session", "b")).toEqual([[3, 1]]);
    expect(versions("group", "a")).toEqual([[5, 1]]);
  });

  it("returns every envelope field, filling in the event id, the time and the metadata", () => {
    const { clock } = manualClock("2026-09-24T10:00:00.000Z");
    const log = memoryLog({ clock });
    const { events } = log.append(
      "session",
      "s1",
      [note("first"), { type: "title.set", payload: "Hi", metadata: { summary: { title: "Hi" } } }],
      { actor: "client:desktop", commandId: "c-1", causationId: "cause-1", correlationId: "corr-1" },
    );

    expect(events).toEqual([
      {
        sequence: 1,
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        streamKind: "session",
        streamId: "s1",
        streamVersion: 1,
        type: "note.added",
        occurredAt: "2026-09-24T10:00:00.000Z",
        commandId: "c-1",
        causationId: "cause-1",
        correlationId: "corr-1",
        actor: "client:desktop",
        payload: { text: "first" },
        metadata: {},
      },
      expect.objectContaining({ sequence: 2, streamVersion: 2, payload: "Hi", metadata: { summary: { title: "Hi" } } }),
    ]);
    expect(events[0]?.eventId).not.toBe(events[1]?.eventId);
    expect(log.readStream("session", "s1")).toEqual(events);
  });

  it("stores null for the command, causation and correlation ids when there are none", () => {
    const log = memoryLog();
    const [event] = log.append("session", "s1", [note("x")], { actor: "adapter:claude" }).events;
    expect(event).toMatchObject({ commandId: null, causationId: null, correlationId: null });
  });

  it("keeps a caller's event id and occurred-at time", () => {
    const log = memoryLog();
    const [event] = log.append(
      "session",
      "s1",
      [{ ...note("x"), eventId: "evt-1", occurredAt: "2026-01-01T00:00:00.000Z" }],
      { actor: "test" },
    ).events;
    expect(event).toMatchObject({ eventId: "evt-1", occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("reads one stream after a sequence, in order", () => {
    const log = memoryLog();
    log.append("session", "s1", [note("1"), note("2")], { actor: "test" });
    log.append("session", "other", [note("elsewhere")], { actor: "test" });
    log.append("session", "s1", [note("3")], { actor: "test" });

    expect(log.readStream("session", "s1", 1).map((e) => e.payload)).toEqual([{ text: "2" }, { text: "3" }]);
    expect(log.readStream("session", "s1", 4)).toEqual([]);
  });

  it("is unique on stream kind, stream id and stream version", () => {
    const path = tempDatabase();
    const log = track(openEventLog({ path }));
    log.append("session", "s1", [note("one")], { actor: "test" });

    const raw = new (loadSqlite().DatabaseSync)(path);
    cleanups.unshift(() => raw.close());
    expect(() =>
      raw
        .prepare(
          `INSERT INTO events (event_id, stream_kind, stream_id, stream_version, type, occurred_at,
                               actor, payload, metadata)
           VALUES ('another', 'session', 's1', 1, 'note.added', '2026-09-24T00:00:00.000Z', 'test', '{}', '{}')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("writes none of an append's events when one of them fails", () => {
    const log = memoryLog();
    log.append("session", "s1", [{ ...note("first"), eventId: "taken" }], { actor: "test" });

    expect(() =>
      log.append("session", "s1", [note("would be version 2"), { ...note("clash"), eventId: "taken" }], {
        actor: "test",
      }),
    ).toThrow(/UNIQUE/);
    expect(log.readStream("session", "s1").map((e) => e.payload)).toEqual([{ text: "first" }]);
  });

  it("refuses a payload that is not JSON", () => {
    const log = memoryLog();
    expect(() => log.append("session", "s1", [{ type: "bad", payload: undefined }], { actor: "test" })).toThrow(
      /JSON/,
    );
    expect(log.readStream("session", "s1")).toEqual([]);
  });
});

describe("one transaction for events, projections and the receipt", () => {
  it("rolls back the events and the receipt when a projection write fails", () => {
    const log = memoryLog({ projectors: [failingOn("boom")] });

    expect(() =>
      log.append("session", "s1", [note("fine"), { type: "boom", payload: {} }], {
        actor: "client:1",
        commandId: "c-1",
        receipt: { status: "accepted" },
      }),
    ).toThrow(/projector refused boom/);
    expect(log.readStream("session", "s1")).toEqual([]);
    expect(log.receipt("client:1", "c-1")).toBeNull();
    expect(log.query("SELECT * FROM fails_seen")).toEqual([]);
  });

  it("leaves the log usable after a rolled-back append", () => {
    const log = memoryLog({ projectors: [failingOn("boom")] });
    expect(() => log.append("session", "s1", [{ type: "boom", payload: {} }], { actor: "test" })).toThrow();

    const { events } = log.append("session", "s1", [note("after")], { actor: "test" });
    expect(events.map((e) => e.streamVersion)).toEqual([1]);
    expect(log.query("SELECT sequence FROM fails_seen")).toEqual([{ sequence: events[0]?.sequence }]);
  });
});

describe("subscribers", () => {
  it("are published each committed event, in order, once it is readable by another connection", () => {
    const path = tempDatabase();
    const log = track(openEventLog({ path }));
    const reader = track(openEventLog({ path }));
    const seen: { sequence: number; visibleElsewhere: boolean }[] = [];
    log.subscribe((event) =>
      seen.push({
        sequence: event.sequence,
        visibleElsewhere: reader.readStream("session", "s1").some((e) => e.sequence === event.sequence),
      }),
    );

    log.append("session", "s1", [note("1"), note("2")], { actor: "test" });
    expect(seen).toEqual([
      { sequence: 1, visibleElsewhere: true },
      { sequence: 2, visibleElsewhere: true },
    ]);
  });

  it("are published nothing when an append rolls back", () => {
    const log = memoryLog({ projectors: [failingOn("boom")] });
    const seen: number[] = [];
    log.subscribe((event) => seen.push(event.sequence));

    expect(() => log.append("session", "s1", [note("ok"), { type: "boom", payload: {} }], { actor: "test" })).toThrow();
    expect(seen).toEqual([]);
  });

  it("stop hearing once they unsubscribe", () => {
    const log = memoryLog();
    const seen: number[] = [];
    const unsubscribe = log.subscribe((event) => seen.push(event.sequence));
    log.append("session", "s1", [note("heard")], { actor: "test" });
    unsubscribe();
    log.append("session", "s1", [note("not heard")], { actor: "test" });
    expect(seen).toEqual([1]);
  });

  it("cannot fail an append or starve each other by throwing", () => {
    const errors: unknown[] = [];
    const log = memoryLog({ onSubscriberError: (error) => errors.push(error) });
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error("subscriber bug");
    });
    log.subscribe((event) => seen.push(event.sequence));

    const { events } = log.append("session", "s1", [note("x")], { actor: "test" });
    expect(events).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(errors).toEqual([new Error("subscriber bug")]);
  });
});

describe("command receipts", () => {
  it("record an accepted command with its aggregate, its last sequence and changed true", () => {
    const { clock } = manualClock("2026-09-24T10:00:00.000Z");
    const log = memoryLog({ clock });
    const result = log.append("session", "s1", [note("1"), note("2")], {
      actor: "client:1",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });

    const expected = {
      actor: "client:1",
      commandId: "c-1",
      streamKind: "session",
      streamId: "s1",
      status: "accepted",
      changed: true,
      resultingSequence: 2,
      createdAt: "2026-09-24T10:00:00.000Z",
    };
    expect(result.receipt).toEqual(expected);
    expect(result.duplicate).toBe(false);
    expect(log.receipt("client:1", "c-1")).toEqual(expected);
  });

  it("answer a repeated command id from the same actor with the stored receipt and append nothing", () => {
    const log = memoryLog();
    const published: number[] = [];
    log.subscribe((event) => published.push(event.sequence));
    const options = { actor: "client:1", commandId: "c-1", receipt: { status: "accepted" } } as const;
    const first = log.append("session", "s1", [note("once")], options);

    const retry = log.append("session", "s1", [note("once")], options);
    expect(retry).toEqual({ events: [], receipt: first.receipt, duplicate: true });
    expect(log.readStream("session", "s1")).toHaveLength(1);
    expect(published).toEqual([1]);
  });

  it("treat the same command id from another actor as another command", () => {
    const log = memoryLog();
    log.append("session", "s1", [note("a")], { actor: "client:1", commandId: "c-1", receipt: { status: "accepted" } });
    const other = log.append("session", "s1", [note("b")], {
      actor: "client:2",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });
    expect(other.duplicate).toBe(false);
    expect(log.readStream("session", "s1")).toHaveLength(2);
    expect(log.receipt("client:2", "c-1")).toMatchObject({ resultingSequence: 2 });
  });

  it("record an accepted command with no events as changed false", () => {
    const log = memoryLog();
    const { receipt, events } = log.append("session", "s1", [], {
      actor: "client:1",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });
    expect(events).toEqual([]);
    expect(receipt).toMatchObject({ status: "accepted", changed: false, resultingSequence: null });
  });

  it("record a rejection with reason not_found and no events, and answer its retry with the rejection", () => {
    const log = memoryLog();
    const options = {
      actor: "client:1",
      commandId: "c-1",
      receipt: { status: "rejected", reason: "not_found", message: "no session s9" },
    } as const;
    const { receipt, events } = log.append("session", "s9", [], options);
    expect(events).toEqual([]);
    expect(receipt).toMatchObject({
      streamKind: "session",
      streamId: "s9",
      status: "rejected",
      changed: false,
      reason: "not_found",
      message: "no session s9",
    });

    expect(log.append("session", "s9", [], options)).toEqual({ events: [], receipt, duplicate: true });
    expect(log.readStream("session", "s9")).toEqual([]);
  });

  it("refuse a rejection that carries events, writing nothing", () => {
    const log = memoryLog();
    expect(() =>
      log.append("session", "s1", [note("x")], {
        actor: "client:1",
        commandId: "c-1",
        receipt: { status: "rejected", reason: "conflict" },
      }),
    ).toThrow(/rejected/);
    expect(log.readStream("session", "s1")).toEqual([]);
    expect(log.receipt("client:1", "c-1")).toBeNull();
  });

  it("are absent for a command never seen", () => {
    expect(memoryLog().receipt("client:1", "nope")).toBeNull();
  });

  it("older than 30 days are removed by the retention pass and younger ones stay", () => {
    const time = manualClock("2026-08-01T00:00:00.000Z");
    const log = memoryLog({ clock: time.clock });
    const command = (commandId: string) =>
      log.append("session", "s1", [], { actor: "client:1", commandId, receipt: { status: "accepted" } });

    command("old");
    time.set("2026-08-02T00:00:00.000Z");
    command("exactly-30-days");
    time.set("2026-08-20T00:00:00.000Z");
    command("young");

    const removed = log.pruneReceipts(new Date(new Date("2026-08-02T00:00:00.000Z").getTime() + 30 * DAY));
    expect(removed).toBe(1);
    expect(log.receipt("client:1", "old")).toBeNull();
    expect(log.receipt("client:1", "exactly-30-days")).not.toBeNull();
    expect(log.receipt("client:1", "young")).not.toBeNull();
  });
});

describe("the replay bound", () => {
  it("counts the events and bytes of one stream after a cursor", () => {
    const log = memoryLog();
    log.append("session", "s1", [note("first")], { actor: "test" });
    log.append("session", "s1", [note("second"), { type: "t", payload: [1, 2], metadata: { k: "v" } }], {
      actor: "test",
    });
    log.append("session", "other", [note("not counted")], { actor: "test" });

    const bytes = [
      JSON.stringify({ text: "second" }) + JSON.stringify({}),
      JSON.stringify([1, 2]) + JSON.stringify({ k: "v" }),
    ].join("").length;
    expect(log.replayBound("session", "s1", 1)).toEqual({ events: 2, bytes, withinBound: true });
    expect(log.replayBound("session", "s1", 3)).toEqual({ events: 0, bytes: 0, withinBound: true });
  });

  it("holds 1,000 events and no more", () => {
    expect(REPLAY_BOUND.events).toBe(1000);
    const log = memoryLog();
    log.append("session", "s1", Array.from({ length: 1000 }, (_, i) => note(String(i))), { actor: "test" });
    expect(log.replayBound("session", "s1", 0)).toMatchObject({ events: 1000, withinBound: true });

    log.append("session", "s1", [note("1001")], { actor: "test" });
    expect(log.replayBound("session", "s1", 0)).toMatchObject({ events: 1001, withinBound: false });
    expect(log.replayBound("session", "s1", 1)).toMatchObject({ events: 1000, withinBound: true });
  });

  it("holds 8 MiB and no more, however few the events", () => {
    expect(REPLAY_BOUND.bytes).toBe(8 * 1024 * 1024);
    const log = memoryLog();
    const threeMiB = { type: "transcript.chunk", payload: "x".repeat(3 * 1024 * 1024) };
    log.append("session", "s1", [threeMiB, threeMiB], { actor: "test" });
    expect(log.replayBound("session", "s1", 0)).toMatchObject({ events: 2, withinBound: true });

    log.append("session", "s1", [threeMiB], { actor: "test" });
    const over = log.replayBound("session", "s1", 0);
    expect(over.events).toBe(3);
    expect(over.bytes).toBeGreaterThan(REPLAY_BOUND.bytes);
    expect(over.withinBound).toBe(false);
    expect(log.replayBound("session", "s1", 1)).toMatchObject({ events: 2, withinBound: true });
  });

  it("measures bytes, not characters", () => {
    const log = memoryLog();
    // 2.5 Mi characters of a two-byte character: 5 MiB each, 10 MiB for two, 5 Mi characters.
    const wide = { type: "transcript.chunk", payload: "é".repeat(2.5 * 1024 * 1024) };
    log.append("session", "s1", [wide, wide], { actor: "test" });
    const bound = log.replayBound("session", "s1", 0);
    expect(bound.bytes).toBe(2 * (Buffer.byteLength(JSON.stringify(wide.payload)) + 2));
    expect(bound.withinBound).toBe(false);
  });
});

describe("snapshots", () => {
  it("are absent for a stream that has none", () => {
    expect(memoryLog().readSnapshot("session", "s1")).toBeNull();
  });

  it("are read back with their stream, sequence and payload, the latest replacing the one before", () => {
    const { clock } = manualClock("2026-09-24T10:00:00.000Z");
    const log = memoryLog({ clock });
    log.writeSnapshot("session", "s1", { sequence: 10, payload: { turns: 1 } });
    log.writeSnapshot("session", "s1", { sequence: 20, payload: { turns: 2 } });
    log.writeSnapshot("session", "s2", { sequence: 5, payload: { turns: 9 } });

    expect(log.readSnapshot("session", "s1")).toEqual({
      streamKind: "session",
      streamId: "s1",
      sequence: 20,
      payload: { turns: 2 },
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    expect(log.readSnapshot("session", "s2")).toMatchObject({ sequence: 5 });
    expect(log.readSnapshot("group", "s1")).toBeNull();
  });

  it("survive a restart", () => {
    const path = tempDatabase();
    const first = openEventLog({ path });
    first.writeSnapshot("session", "s1", { sequence: 3, payload: ["kept"] });
    first.close();
    expect(track(openEventLog({ path })).readSnapshot("session", "s1")).toMatchObject({
      sequence: 3,
      payload: ["kept"],
    });
  });
});
