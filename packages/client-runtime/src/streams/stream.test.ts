import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { added, groupEvent, groupOf, noticeEvent, sessionEvent, summaryOf, unpatchedEvent } from "../../test/events.js";
import { SESSION_EVENTS_BOUND, SESSION_EVENT_BYTES_BOUND, environmentKind, listKind, sessionKind, type ListData } from "./kinds.js";
import { cachedStream, emptyStream, step, type StreamInput, type StreamState } from "./stream.js";

/**
 * The stream reducer as a pure function (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots"): what one subscribed stream
 * does with each message, with no socket, no clock and no storage.
 */

const list = listKind();
const a = randomUUID();
const b = randomUUID();

const run = (state: StreamState<ListData>, ...inputs: StreamInput[]) => {
  let current = state;
  const persisted: string[] = [];
  for (const input of inputs) {
    const next = step(list, current, input);
    current = next.state;
    persisted.push(next.persist);
  }
  return { state: current, persisted };
};

const ids = (state: StreamState<ListData>) => [...(state.data?.sessions.keys() ?? [])].sort();
const snapshot = (sequence: number, sessions = [summaryOf(a)], groups = [groupOf(randomUUID(), "Brandsolidate")]): StreamInput => ({
  type: "snapshot",
  sequence,
  payload: { sequence, sessions, groups },
});

describe("the stream reducer", () => {
  it("starts empty with no cursor, or cached from what was saved", () => {
    expect(emptyStream()).toEqual({ cursor: null, data: null, freshness: "empty", fault: null });
    const cached = cachedStream(7, list.empty());
    expect(cached).toMatchObject({ cursor: 7, freshness: "cached", fault: null });
  });

  it("is catching up once attached, and live on synchronized, which moves the cursor to the head it names", () => {
    const { state, persisted } = run(cachedStream(3, list.empty()), { type: "attaching" }, { type: "synchronized", sequence: 9 });
    expect(state).toMatchObject({ cursor: 9, freshness: "live" });
    // Forced on every synchronized marker.
    expect(persisted).toEqual(["none", "now"]);
  });

  it("is catching up from nothing when the cache is empty, and synchronized leaves an empty list cached at the head", () => {
    const attached = run(emptyStream(), { type: "attaching" });
    expect(attached.state).toMatchObject({ cursor: null, freshness: "catching-up" });
    const synced = run(attached.state, { type: "synchronized", sequence: 4 });
    expect(synced.state).toMatchObject({ cursor: 4, freshness: "live" });
    expect(ids(synced.state)).toEqual([]);
  });

  it("applies an event above the cursor and advances the cursor to it; the write is debounced", () => {
    const { state, persisted } = run(emptyStream(), { type: "attaching" }, { type: "event", sequence: 5, event: sessionEvent(5, added(summaryOf(a))) });
    expect(ids(state)).toEqual([a]);
    expect(state.cursor).toBe(5);
    expect(persisted.at(-1)).toBe("soon");
  });

  it("drops an event at or below the cursor, so the overlap of catch-up and live applies once", () => {
    const archived = sessionEvent(6, { op: "set", sessionId: a, fields: { archivedAt: "2026-09-24T01:00:00.000Z" } });
    const { state, persisted } = run(
      emptyStream(),
      { type: "attaching" },
      { type: "event", sequence: 5, event: sessionEvent(5, added(summaryOf(a))) },
      { type: "event", sequence: 6, event: archived },
      { type: "synchronized", sequence: 6 },
      // The live feed attached before catch-up, so it repeats both.
      { type: "event", sequence: 5, event: sessionEvent(5, added(summaryOf(a))) },
      { type: "event", sequence: 6, event: { ...archived, metadata: { listPatch: { op: "set", sessionId: a, fields: { archivedAt: null } } } } },
    );
    expect(state.data?.sessions.get(a)?.archivedAt).toBe("2026-09-24T01:00:00.000Z");
    expect(state.cursor).toBe(6);
    expect(persisted.slice(-2)).toEqual(["none", "none"]);
  });

  it("replaces state and cursor whole on a snapshot, even a cursor that goes back", () => {
    const before = run(emptyStream(), { type: "attaching" }, { type: "event", sequence: 40, event: sessionEvent(40, added(summaryOf(b))) });
    const { state } = run(before.state, snapshot(12));
    expect(ids(state)).toEqual([a]);
    expect(state.cursor).toBe(12);
    expect(state.data?.groups.size).toBe(1);
    expect(state.freshness).toBe("catching-up");
  });

  it("applies set and remove patches, group patches, and skips an event with no patch", () => {
    const groupId = randomUUID();
    const { state } = run(
      emptyStream(),
      { type: "attaching" },
      { type: "event", sequence: 1, event: sessionEvent(1, added(summaryOf(a))) },
      { type: "event", sequence: 2, event: sessionEvent(2, added(summaryOf(b))) },
      { type: "event", sequence: 3, event: groupEvent(3, { op: "add", group: groupOf(groupId, "Cool Jams") }, "group.created") },
      { type: "event", sequence: 4, event: sessionEvent(4, { op: "set", sessionId: a, fields: { groupId, title: "Invoices" } }) },
      { type: "event", sequence: 5, event: groupEvent(5, { op: "set", groupId, fields: { name: "Cool jams" } }) },
      { type: "event", sequence: 6, event: sessionEvent(6, { op: "remove", sessionId: b }, "session.deleted") },
      { type: "event", sequence: 7, event: unpatchedEvent(7, b) },
    );
    expect(ids(state)).toEqual([a]);
    expect(state.data?.sessions.get(a)).toMatchObject({ groupId, title: "Invoices" });
    expect(state.data?.groups.get(groupId)?.name).toBe("Cool jams");
    expect(state.cursor).toBe(7);
  });

  it("never advances the cursor on an apply that fails: state and cursor stay, and the stream is faulted", () => {
    const start = run(emptyStream(), { type: "attaching" }, { type: "event", sequence: 5, event: sessionEvent(5, added(summaryOf(a))) });
    // A patch for a session the list does not hold: the apply cannot finish.
    const bad = step(list, start.state, { type: "event", sequence: 6, event: sessionEvent(6, { op: "set", sessionId: b, fields: { title: "x" } }) });
    expect(bad.failed).toMatch(/not in the list/);
    expect(bad.persist).toBe("none");
    expect(bad.state.cursor).toBe(5);
    expect(bad.state.data).toBe(start.state.data);
    expect(bad.state.fault).toMatch(/not in the list/);
    // A malformed patch fails the same way.
    const malformed = step(list, start.state, { type: "event", sequence: 6, event: { ...sessionEvent(6, added(summaryOf(b))), metadata: { listPatch: { op: "nope" } } } });
    expect(malformed.state.cursor).toBe(5);
    expect(malformed.failed).toBeDefined();
  });

  it("goes back to cached on an end, a fault or a detach, keeping the data; empty when there is none", () => {
    const live = run(cachedStream(3, list.empty()), { type: "attaching" }, { type: "synchronized", sequence: 3 }).state;
    expect(step(list, live, { type: "end", reason: "overflow" })).toMatchObject({ state: { freshness: "cached", cursor: 3 }, persist: "now" });
    expect(step(list, live, { type: "detached" })).toMatchObject({ state: { freshness: "cached" }, persist: "now" });
    expect(step(list, live, { type: "fault", message: "forbidden" }).state).toMatchObject({ freshness: "cached", fault: "forbidden" });
    const attaching = run(emptyStream(), { type: "attaching" }).state;
    expect(step(list, attaching, { type: "fault", message: "no" }).state).toMatchObject({ freshness: "empty", fault: "no" });
  });

  it("keeps a fault showing while it catches up again, and clears it once synchronized", () => {
    const faulted = step(list, cachedStream(3, list.empty()), { type: "fault", message: "internal" }).state;
    const again = run(faulted, { type: "attaching" });
    expect(again.state).toMatchObject({ freshness: "catching-up", fault: "internal" });
    expect(run(again.state, { type: "synchronized", sequence: 3 }).state).toMatchObject({ freshness: "live", fault: null });
  });
});

describe("the session stream kind", () => {
  it("takes the summary from its snapshot, keeps every event after it, and follows the summary through the patches", () => {
    const kind = sessionKind();
    const snap = kind.fromSnapshot({ sequence: 3, summary: summaryOf(a), transcript: {} });
    const unknown = { ...unpatchedEvent(4, a, "run.somethingNew"), payload: { future: true } };
    const renamed = kind.apply(kind.apply(snap, unknown), sessionEvent(5, { op: "set", sessionId: a, fields: { title: "Renamed" } }, "session.title-set"));
    expect(renamed.summary?.title).toBe("Renamed");
    expect(renamed.events.map((e) => e.type)).toEqual(["run.somethingNew", "session.title-set"]);
    expect(kind.decode(JSON.parse(JSON.stringify(kind.encode(renamed))))).toEqual(renamed);
  });

  it("holds nothing after a bare synchronized, never a session that reads as gone, and is live once an event describes it", () => {
    const kind = sessionKind();
    const attached = step(kind, emptyStream(), { type: "attaching" }).state;
    const synced = step(kind, attached, { type: "synchronized", sequence: 0 });
    expect(synced.state).toEqual({ cursor: null, data: null, freshness: "empty", fault: null });
    expect(synced.persist).toBe("none");
    const described = step(kind, synced.state, { type: "event", sequence: 1, event: sessionEvent(1, added(summaryOf(a)), "session.created") });
    expect(described.state).toMatchObject({ cursor: 1, freshness: "live", data: { summary: { id: a } } });
  });

  it("has outgrown what it keeps between snapshots past the event count or the byte bound", () => {
    const kind = sessionKind();
    let data = kind.fromSnapshot({ sequence: 1, summary: summaryOf(a), transcript: {} });
    for (let sequence = 2; sequence < 2 + SESSION_EVENTS_BOUND; sequence++) data = kind.apply(data, unpatchedEvent(sequence, a, "run.output"));
    expect(kind.outgrown?.(data)).toBe(false);
    expect(kind.outgrown?.(kind.apply(data, unpatchedEvent(2 + SESSION_EVENTS_BOUND, a, "run.output")))).toBe(true);

    const big = { ...unpatchedEvent(2, a, "run.output"), payload: { text: "x".repeat(SESSION_EVENT_BYTES_BOUND) } };
    const heavy = kind.apply(kind.fromSnapshot({ sequence: 1, summary: summaryOf(a), transcript: {} }), big);
    expect(kind.outgrown?.(heavy)).toBe(true);
    // The count is not stored; it is taken again from what is.
    expect(kind.decode(JSON.parse(JSON.stringify(kind.encode(heavy))))).toEqual(heavy);
  });
});

describe("the environment stream kind", () => {
  const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false };

  it("follows the status through a drain and the start after it", () => {
    const kind = environmentKind();
    const held = kind.fromSnapshot({ sequence: 1, status });
    const draining = kind.apply(held, noticeEvent(2, "env", "environment.draining", { drainingSince: "2026-09-24T01:00:00.000Z", trigger: "command" }));
    expect(draining.status).toMatchObject({ readiness: "draining", activity: { state: "draining", drainingSince: "2026-09-24T01:00:00.000Z" } });
    const started = kind.apply(draining, noticeEvent(3, "env", "environment.started", { harnessVersion: "0.2.0", protocolVersion: 1 }));
    expect(started.status).toEqual(status);
    // A notice this client does not know changes nothing.
    expect(kind.apply(started, noticeEvent(4, "env", "environment.renamed", { name: "desk" }))).toBe(started);
  });
});
