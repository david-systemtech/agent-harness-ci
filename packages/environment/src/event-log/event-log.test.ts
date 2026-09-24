import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventInput, JsonObject, StreamRef } from "./envelope.js";
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

const s1: StreamRef = { kind: "session", id: "s1" };

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
    expect(log.read("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(log.read("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("turns foreign keys on for an in-memory database too", () => {
    expect(memoryLog().read("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("creates its tables by applying the migrations on open", () => {
    const log = memoryLog();
    const tables = log
      .read<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((t) => t.name);
    expect(tables.sort()).toEqual(["client_sessions", "command_receipts", "events", "projection_state", "snapshots"]);
    expect(log.read("PRAGMA user_version")).toEqual([{ user_version: MIGRATIONS.length }]);
  });

  it("applies no migration twice when a database file is reopened", () => {
    const path = tempDatabase();
    const first = openEventLog({ path });
    first.append(s1, [note("kept")], { actor: "system:test" });
    first.close();

    const second = track(openEventLog({ path }));
    expect(second.readStream(s1).map((e) => e.payload)).toEqual([{ text: "kept" }]);
    expect(second.read("PRAGMA user_version")).toEqual([{ user_version: MIGRATIONS.length }]);
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

describe("reading rows", () => {
  it("refuses a statement that writes, and leaves the log intact", () => {
    const log = memoryLog();
    log.append(s1, [note("kept")], { actor: "system:test" });

    expect(() => log.read("DELETE FROM events")).toThrow(/readonly/);
    expect(log.readStream(s1)).toHaveLength(1);
    log.append(s1, [note("still writable")], { actor: "system:test" });
    expect(log.readStream(s1)).toHaveLength(2);
  });

  it("reads a projection's table", () => {
    const log = memoryLog({
      projectors: [
        {
          name: "titles",
          tables: { titles: "CREATE TABLE titles (stream_id TEXT PRIMARY KEY, title TEXT NOT NULL)" },
          apply: (event, db) => {
            if (event.type === "title.set") {
              db.run("INSERT OR REPLACE INTO titles VALUES (?, ?)", event.streamId, String(event.payload["title"]));
            }
          },
        },
      ],
    });
    log.append(s1, [{ type: "title.set", payload: { title: "Hello" } }], { actor: "system:test" });
    expect(log.read("SELECT stream_id, title FROM titles WHERE stream_id = ?", "s1")).toEqual([
      { stream_id: "s1", title: "Hello" },
    ]);
  });
});

describe("appending", () => {
  it("gives each event the next global sequence and the next version of its own stream", () => {
    const log = memoryLog();
    log.append({ kind: "session", id: "a" }, [note("a1"), note("a2")], { actor: "system:test" });
    log.append({ kind: "session", id: "b" }, [note("b1")], { actor: "system:test" });
    log.append({ kind: "session", id: "a" }, [note("a3")], { actor: "system:test" });
    log.append({ kind: "group", id: "a" }, [note("group a1")], { actor: "system:test" });

    const versions = (kind: string, id: string) =>
      log.readStream({ kind, id }).map((e) => [e.sequence, e.streamVersion]);
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
      s1,
      [note("first"), { type: "title.set", payload: { title: "Hi" }, metadata: { summary: { title: "Hi" } } }],
      { actor: "client_session:desktop", commandId: "c-1", causationId: "cause-1", correlationId: "corr-1" },
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
        actor: "client_session:desktop",
        payload: { text: "first" },
        metadata: {},
      },
      expect.objectContaining({ sequence: 2, streamVersion: 2, payload: { title: "Hi" }, metadata: { summary: { title: "Hi" } } }),
    ]);
    expect(events[0]?.eventId).not.toBe(events[1]?.eventId);
    expect(log.readStream(s1)).toEqual(events);
  });

  it("stores null for the command, causation and correlation ids when there are none", () => {
    const log = memoryLog();
    const [event] = log.append(s1, [note("x")], { actor: "adapter:claude" }).events;
    expect(event).toMatchObject({ commandId: null, causationId: null, correlationId: null });
  });

  it("keeps a caller's event id and occurred-at time", () => {
    const log = memoryLog();
    const [event] = log.append(
      s1,
      [{ ...note("x"), eventId: "evt-1", occurredAt: "2026-01-01T00:00:00.000Z" }],
      { actor: "system:test" },
    ).events;
    expect(event).toMatchObject({ eventId: "evt-1", occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("reads one stream after a sequence, in order", () => {
    const log = memoryLog();
    log.append(s1, [note("1"), note("2")], { actor: "system:test" });
    log.append({ kind: "session", id: "other" }, [note("elsewhere")], { actor: "system:test" });
    log.append(s1, [note("3")], { actor: "system:test" });

    expect(log.readStream(s1, 1).map((e) => e.payload)).toEqual([{ text: "2" }, { text: "3" }]);
    expect(log.readStream(s1, 4)).toEqual([]);
  });

  it("names its head: the last sequence given out, 0 before the first, never lowered by a rollback", () => {
    const log = memoryLog();
    expect(log.head()).toBe(0);
    log.append(s1, [note("1"), note("2")], { actor: "system:test" });
    log.append({ kind: "session", id: "other" }, [note("elsewhere")], { actor: "system:test" });
    expect(log.head()).toBe(3);
    const failing: Projector = {
      name: "failing",
      tables: {},
      apply: (event) => {
        if (event.type === "boom") throw new Error("the projection failed");
      },
    };
    log.registerProjector(failing);
    expect(() => log.append(s1, [{ type: "boom", payload: {} }], { actor: "system:test" })).toThrow(/projection failed/);
    expect(log.head()).toBe(3);
  });

  it("is unique on stream kind, stream id and stream version", () => {
    const path = tempDatabase();
    const log = track(openEventLog({ path }));
    log.append(s1, [note("one")], { actor: "system:test" });

    const raw = new (loadSqlite().DatabaseSync)(path);
    cleanups.push(() => raw.close());
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
    log.append(s1, [{ ...note("first"), eventId: "taken" }], { actor: "system:test" });

    expect(() =>
      log.append(s1, [note("would be version 2"), { ...note("clash"), eventId: "taken" }], {
        actor: "system:test",
      }),
    ).toThrow(/UNIQUE/);
    expect(log.readStream(s1).map((e) => e.payload)).toEqual([{ text: "first" }]);
  });

  it("refuses an actor that is not kind:id of a known kind, naming it, and writes nothing", () => {
    const log = memoryLog();
    log.append(s1, [note("before")], { actor: "system:test" });
    const before = log.readStream(s1);
    for (const actor of ["test", "client:desktop", "user:david", ":x", "system:", ""]) {
      expect(() => log.append(s1, [note("refused")], { actor }), actor).toThrow(
        `The actor of an append is not kind:id of a known kind (client_session, routine, adapter, system): ${JSON.stringify(actor)}.`,
      );
      expect(() => log.append(s1, [], { actor, commandId: "c-1", receipt: { status: "accepted" } }), actor).toThrow(/not kind:id/);
    }
    expect(log.readStream(s1)).toEqual(before);
    expect(log.head()).toBe(1);
    expect(log.receipt("", "c-1")).toBeNull();
  });

  it("refuses a payload or metadata that is not a JSON object, naming the event, and writes none of the append", () => {
    const log = memoryLog();
    for (const [payload, got] of [
      [undefined, "a undefined"],
      ["Hello", "a string"],
      [[1, 2], "an array"],
      [null, "null"],
      [3, "a number"],
    ] as const) {
      const bad = { type: "bad", payload: payload as unknown as JsonObject };
      expect(() => log.append(s1, [note("fine"), bad], { actor: "system:test" }), String(payload)).toThrow(
        `The payload of a bad event must be a JSON object; got ${got}.`,
      );
    }
    const badMetadata = { type: "bad", payload: {}, metadata: ["m"] as unknown as JsonObject };
    expect(() => log.append(s1, [badMetadata], { actor: "system:test" })).toThrow("The metadata of a bad event must be a JSON object; got an array.");
    expect(log.readStream(s1)).toEqual([]);
  });

  it("refuses a payload holding a non-finite number rather than storing null", () => {
    const log = memoryLog();
    expect(() => log.append(s1, [{ type: "bad", payload: { text: NaN } }], { actor: "system:test" })).toThrow(/NaN/);
    expect(() => log.append(s1, [{ type: "bad", payload: { list: [Infinity] } }], { actor: "system:test" })).toThrow(/Infinity/);
    expect(log.readStream(s1)).toEqual([]);
  });

  it("refuses a payload holding a nested undefined, function or symbol rather than dropping it", () => {
    const log = memoryLog();
    expect(() => log.append(s1, [{ type: "bad", payload: { text: undefined } }], { actor: "system:test" })).toThrow(/undefined/);
    expect(() => log.append(s1, [{ type: "bad", payload: { list: [undefined] } }], { actor: "system:test" })).toThrow(/undefined/);
    expect(() => log.append(s1, [{ type: "bad", payload: { f: () => 1 } }], { actor: "system:test" })).toThrow(/cannot hold/);
    expect(() => log.append(s1, [{ type: "bad", payload: {}, metadata: { s: Symbol("x") } }], { actor: "system:test" })).toThrow(
      /cannot hold/,
    );
    expect(log.readStream(s1)).toEqual([]);
  });
});

describe("one transaction for events, projections and the receipt", () => {
  it("rolls back the events and the receipt when a projection write fails", () => {
    const log = memoryLog({ projectors: [failingOn("boom")] });

    expect(() =>
      log.append(s1, [note("fine"), { type: "boom", payload: {} }], {
        actor: "client_session:1",
        commandId: "c-1",
        receipt: { status: "accepted" },
      }),
    ).toThrow(/projector refused boom/);
    expect(log.readStream(s1)).toEqual([]);
    expect(log.receipt("client_session:1", "c-1")).toBeNull();
    expect(log.read("SELECT * FROM fails_seen")).toEqual([]);
  });

  it("leaves the log usable after a rolled-back append", () => {
    const log = memoryLog({ projectors: [failingOn("boom")] });
    expect(() => log.append(s1, [{ type: "boom", payload: {} }], { actor: "system:test" })).toThrow();

    const { events } = log.append(s1, [note("after")], { actor: "system:test" });
    expect(events.map((e) => e.streamVersion)).toEqual([1]);
    expect(log.read("SELECT sequence FROM fails_seen")).toEqual([{ sequence: events[0]?.sequence }]);
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
        visibleElsewhere: reader.readStream(s1).some((e) => e.sequence === event.sequence),
      }),
    );

    log.append(s1, [note("1"), note("2")], { actor: "system:test" });
    expect(seen).toEqual([
      { sequence: 1, visibleElsewhere: true },
      { sequence: 2, visibleElsewhere: true },
    ]);
  });

  it("hear sequences in ascending order when a subscriber appends while being published to", () => {
    const log = memoryLog();
    const heardByA: number[] = [];
    const heardByB: number[] = [];
    log.subscribe((event) => {
      heardByA.push(event.sequence);
      if (event.sequence === 1) log.append(s1, [note("from A")], { actor: "system:a" });
    });
    log.subscribe((event) => heardByB.push(event.sequence));

    log.append(s1, [note("1"), note("2")], { actor: "system:test" });
    expect(heardByA).toEqual([1, 2, 3]);
    expect(heardByB).toEqual([1, 2, 3]);
  });

  it("are published nothing when an append rolls back", () => {
    const log = memoryLog({ projectors: [failingOn("boom")] });
    const seen: number[] = [];
    log.subscribe((event) => seen.push(event.sequence));

    expect(() => log.append(s1, [note("ok"), { type: "boom", payload: {} }], { actor: "system:test" })).toThrow();
    expect(seen).toEqual([]);
  });

  it("stop hearing once they unsubscribe", () => {
    const log = memoryLog();
    const seen: number[] = [];
    const unsubscribe = log.subscribe((event) => seen.push(event.sequence));
    log.append(s1, [note("heard")], { actor: "system:test" });
    unsubscribe();
    log.append(s1, [note("not heard")], { actor: "system:test" });
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

    const { events } = log.append(s1, [note("x")], { actor: "system:test" });
    expect(events).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(errors).toEqual([new Error("subscriber bug")]);
  });
});

describe("command receipts", () => {
  it("record an accepted command with its aggregate, its last sequence and changed true", () => {
    const { clock } = manualClock("2026-09-24T10:00:00.000Z");
    const log = memoryLog({ clock });
    const result = log.append(s1, [note("1"), note("2")], {
      actor: "client_session:1",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });

    const expected = {
      actor: "client_session:1",
      commandId: "c-1",
      stream: s1,
      status: "accepted",
      changed: true,
      resultingSequence: 2,
      createdAt: "2026-09-24T10:00:00.000Z",
    };
    expect(result.receipt).toEqual(expected);
    expect(result.duplicate).toBe(false);
    expect(log.receipt("client_session:1", "c-1")).toEqual(expected);
  });

  it("answer a repeated command id from the same actor with the stored receipt and append nothing", () => {
    const log = memoryLog();
    const published: number[] = [];
    log.subscribe((event) => published.push(event.sequence));
    const options = { actor: "client_session:1", commandId: "c-1", receipt: { status: "accepted" } } as const;
    const first = log.append(s1, [note("once")], options);

    const retry = log.append(s1, [note("once")], options);
    expect(retry).toEqual({ events: [], receipt: first.receipt, duplicate: true });
    expect(log.readStream(s1)).toHaveLength(1);
    expect(published).toEqual([1]);
  });

  it("treat the same command id from another actor as another command", () => {
    const log = memoryLog();
    log.append(s1, [note("a")], { actor: "client_session:1", commandId: "c-1", receipt: { status: "accepted" } });
    const other = log.append(s1, [note("b")], {
      actor: "client_session:2",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });
    expect(other.duplicate).toBe(false);
    expect(log.readStream(s1)).toHaveLength(2);
    expect(log.receipt("client_session:2", "c-1")).toMatchObject({ resultingSequence: 2 });
  });

  it("record an accepted command with no events as changed false", () => {
    const log = memoryLog();
    const { receipt, events } = log.append(s1, [], {
      actor: "client_session:1",
      commandId: "c-1",
      receipt: { status: "accepted" },
    });
    expect(events).toEqual([]);
    expect(receipt).toMatchObject({ status: "accepted", changed: false, resultingSequence: null });
  });

  it("record a rejection with reason not_found and no events, and answer its retry with the rejection", () => {
    const log = memoryLog();
    const options = {
      actor: "client_session:1",
      commandId: "c-1",
      receipt: { status: "rejected", reason: "not_found", message: "no session s9" },
    } as const;
    const { receipt, events } = log.append({ kind: "session", id: "s9" }, [], options);
    expect(events).toEqual([]);
    expect(receipt).toMatchObject({
      stream: { kind: "session", id: "s9" },
      status: "rejected",
      changed: false,
      reason: "not_found",
      message: "no session s9",
    });

    expect(log.append({ kind: "session", id: "s9" }, [], options)).toEqual({ events: [], receipt, duplicate: true });
    expect(log.readStream({ kind: "session", id: "s9" })).toEqual([]);
  });

  it("refuse a rejection that carries events, writing nothing", () => {
    const log = memoryLog();
    expect(() =>
      log.append(s1, [note("x")], {
        actor: "client_session:1",
        commandId: "c-1",
        receipt: { status: "rejected", reason: "conflict" },
      }),
    ).toThrow(/rejected/);
    expect(log.readStream(s1)).toEqual([]);
    expect(log.receipt("client_session:1", "c-1")).toBeNull();
  });

  it("are absent for a command never seen", () => {
    expect(memoryLog().receipt("client_session:1", "nope")).toBeNull();
  });

  it("older than 30 days are removed by the retention pass and younger ones stay", () => {
    const time = manualClock("2026-08-01T00:00:00.000Z");
    const log = memoryLog({ clock: time.clock });
    const command = (commandId: string) =>
      log.append(s1, [], { actor: "client_session:1", commandId, receipt: { status: "accepted" } });

    command("old");
    time.set("2026-08-02T00:00:00.000Z");
    command("exactly-30-days");
    time.set("2026-08-20T00:00:00.000Z");
    command("young");

    const removed = log.pruneReceipts(new Date(new Date("2026-08-02T00:00:00.000Z").getTime() + 30 * DAY));
    expect(removed).toBe(1);
    expect(log.receipt("client_session:1", "old")).toBeNull();
    expect(log.receipt("client_session:1", "exactly-30-days")).not.toBeNull();
    expect(log.receipt("client_session:1", "young")).not.toBeNull();

    // "Older than 30 days": one millisecond past the boundary is old.
    expect(log.pruneReceipts(new Date(new Date("2026-08-02T00:00:00.000Z").getTime() + 30 * DAY + 1))).toBe(1);
    expect(log.receipt("client_session:1", "exactly-30-days")).toBeNull();
    expect(log.receipt("client_session:1", "young")).not.toBeNull();
  });
});

describe("the replay bound", () => {
  it("counts the events and bytes of one stream after a cursor", () => {
    const log = memoryLog();
    log.append(s1, [note("first")], { actor: "system:test" });
    log.append(s1, [note("second"), { type: "t", payload: { list: [1, 2] }, metadata: { k: "v" } }], {
      actor: "system:test",
    });
    log.append({ kind: "session", id: "other" }, [note("not counted")], { actor: "system:test" });

    const bytes = [
      JSON.stringify({ text: "second" }) + JSON.stringify({}),
      JSON.stringify({ list: [1, 2] }) + JSON.stringify({ k: "v" }),
    ].join("").length;
    expect(log.replayBound(s1, 1)).toEqual({ events: 2, bytes, withinBound: true });
    expect(log.replayBound(s1, 3)).toEqual({ events: 0, bytes: 0, withinBound: true });
  });

  it("holds 1,000 events and no more", () => {
    expect(REPLAY_BOUND.events).toBe(1000);
    const log = memoryLog();
    log.append(s1, Array.from({ length: 1000 }, (_, i) => note(String(i))), { actor: "system:test" });
    expect(log.replayBound(s1, 0)).toMatchObject({ events: 1000, withinBound: true });

    log.append(s1, [note("1001")], { actor: "system:test" });
    expect(log.replayBound(s1, 0)).toMatchObject({ events: 1001, withinBound: false });
    expect(log.replayBound(s1, 1)).toMatchObject({ events: 1000, withinBound: true });
  });

  it("holds 8 MiB and no more, however few the events", () => {
    expect(REPLAY_BOUND.bytes).toBe(8 * 1024 * 1024);
    const log = memoryLog();
    const threeMiB = { type: "transcript.chunk", payload: { text: "x".repeat(3 * 1024 * 1024) } };
    log.append(s1, [threeMiB, threeMiB], { actor: "system:test" });
    expect(log.replayBound(s1, 0)).toMatchObject({ events: 2, withinBound: true });

    log.append(s1, [threeMiB], { actor: "system:test" });
    const over = log.replayBound(s1, 0);
    expect(over.events).toBe(3);
    expect(over.bytes).toBeGreaterThan(REPLAY_BOUND.bytes);
    expect(over.withinBound).toBe(false);
    expect(log.replayBound(s1, 1)).toMatchObject({ events: 2, withinBound: true });
  });

  it("holds exactly 8 MiB and not one byte more", () => {
    const log = memoryLog();
    // The stored payload is `{"text":"…"}`, eleven bytes around the text; metadata is stored as `{}`, two bytes.
    const exact = { type: "transcript.chunk", payload: { text: "x".repeat(REPLAY_BOUND.bytes - 13) } };
    log.append(s1, [exact], { actor: "system:test" });
    expect(log.replayBound(s1, 0)).toMatchObject({ bytes: REPLAY_BOUND.bytes, withinBound: true });

    log.append(s1, [{ type: "transcript.chunk", payload: {} }], { actor: "system:test" });
    const over = log.replayBound(s1, 0);
    expect(over.bytes).toBe(REPLAY_BOUND.bytes + 4);
    expect(over.withinBound).toBe(false);
  });

  it("measures bytes, not characters", () => {
    const log = memoryLog();
    // 2.5 Mi characters of a two-byte character: 5 MiB each, 10 MiB for two, 5 Mi characters.
    const wide = { type: "transcript.chunk", payload: { text: "é".repeat(2.5 * 1024 * 1024) } };
    log.append(s1, [wide, wide], { actor: "system:test" });
    const bound = log.replayBound(s1, 0);
    expect(bound.bytes).toBe(2 * (Buffer.byteLength(JSON.stringify(wide.payload)) + 2));
    expect(bound.withinBound).toBe(false);
  });
});

describe("snapshots", () => {
  it("are absent for a stream that has none", () => {
    expect(memoryLog().readSnapshot(s1)).toBeNull();
  });

  it("are read back with their stream, sequence and payload, the latest replacing the one before", () => {
    const { clock } = manualClock("2026-09-24T10:00:00.000Z");
    const log = memoryLog({ clock });
    log.writeSnapshot(s1, { sequence: 10, payload: { turns: 1 } });
    log.writeSnapshot(s1, { sequence: 20, payload: { turns: 2 } });
    log.writeSnapshot({ kind: "session", id: "s2" }, { sequence: 5, payload: { turns: 9 } });

    expect(log.readSnapshot(s1)).toEqual({
      stream: s1,
      sequence: 20,
      payload: { turns: 2 },
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    expect(log.readSnapshot({ kind: "session", id: "s2" })).toMatchObject({ sequence: 5 });
    expect(log.readSnapshot({ kind: "group", id: "s1" })).toBeNull();
  });

  it("survive a restart", () => {
    const path = tempDatabase();
    const first = openEventLog({ path });
    first.writeSnapshot(s1, { sequence: 3, payload: ["kept"] });
    first.close();
    expect(track(openEventLog({ path })).readSnapshot(s1)).toMatchObject({
      sequence: 3,
      payload: ["kept"],
    });
  });
});
