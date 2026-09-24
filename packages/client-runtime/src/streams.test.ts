import { randomUUID } from "node:crypto";
import type { EndReason, EventEnvelope, SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { added, groupOf, noticeEvent, sessionEvent, summaryOf } from "../test/events.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { DocumentStore, SecretStore } from "./platform.js";
import type { Runtime } from "./runtime.js";
import { SESSION_LINGER_MS } from "./streams/session-handles.js";
import { STREAM_WRITE_DEBOUNCE_MS, streamDocument } from "./streams/cache.js";
import { SUBSCRIBE_TIMEOUT_MS } from "./streams/attach.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { inMemoryDocuments, inMemoryPlatform, manualClock, type InMemoryDocumentStore, type ManualClock } from "./testing/in-memory-platform.js";

/**
 * Subscriptions through the fake wire (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots", and the second test seam):
 * the environment's side of each subscription is scripted frame by frame
 * under the manual clock. What is asserted is what a renderer sees (the
 * session list, its freshness, the connection's phase) and what the
 * environment sees (the subscriptions asked for, from which cursor); the
 * cache documents are read only where durability is the behaviour.
 */

const MINUTE = 60_000;

/** A document store whose `set`s are recorded. */
const recording = (store: InMemoryDocumentStore = inMemoryDocuments()) => {
  const sets: [string, unknown][] = [];
  const documents: InMemoryDocumentStore = {
    ...store,
    async set(key, value) {
      sets.push([key, value]);
      await store.set(key, value);
    },
  };
  return { documents, sets };
};

/** One subscription as the environment scripts it: answered `subscribed`, then whatever the test sends on it. */
interface Scripted {
  readonly params: Record<string, unknown>;
  snapshot(sequence: number, payload: Record<string, unknown>): void;
  event(event: EventEnvelope): void;
  synchronized(sequence: number): void;
  end(reason: EndReason): void;
}

let minted = 0;

/** Waits for the client to ask `method`, answers it `subscribed` with a fresh id, and hands back its script. */
const subscription = async (wire: FakeWire, method: string): Promise<Scripted> => {
  const request = await wire.server.request(method);
  const id = `sub-${++minted}`;
  wire.server.send({ type: "subscribed", id: request.id, subscription: id });
  return {
    params: request.params,
    snapshot: (sequence, payload) => wire.server.send({ type: "snapshot", subscription: id, sequence, payload }),
    event: (event) => wire.server.send({ type: "event", subscription: id, sequence: event.sequence, event }),
    synchronized: (sequence) => wire.server.send({ type: "synchronized", subscription: id, sequence }),
    end: (reason) => wire.server.send({ type: "end", subscription: id, reason }),
  };
};

interface Setup {
  readonly clock?: ManualClock;
  readonly documents?: DocumentStore & InMemoryDocumentStore;
  /** Another runtime's secrets, to start again on what it saved. */
  readonly secrets?: SecretStore;
  readonly wire?: FakeWire;
  readonly offline?: boolean;
}

/** A runtime on the fake wire whose subscriptions the test scripts: every stream request is left for the test to answer. */
const runtimeOn = (setup: Setup = {}) => {
  const clock = setup.clock ?? manualClock();
  const wire = setup.wire ?? fakeWire({ clock, name: "desk" });
  for (const method of ["sessions.subscribe", "environment.subscribe", "sessions.subscribeSession"]) wire.answer(method, () => undefined);
  const platform = inMemoryPlatform({
    clock,
    fetch: wire.fetch,
    webSocket: wire.webSocket,
    ...(setup.documents && { documents: setup.documents }),
    ...(setup.secrets && { secrets: setup.secrets }),
  });
  if (setup.offline) platform.network.setOnline(false);
  const { runtime, seams } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  return { clock, wire, platform, runtime, seams };
};

/** Paired and ready, with the session list subscribed and synchronized at `head` (an empty list), unless told to leave it to the test. */
const paired = async (setup: Setup = {}) => {
  const s = runtimeOn(setup);
  await s.runtime.start();
  const adding = s.runtime.connections.add({ link: s.wire.link });
  await s.wire.server.accept();
  const list = await subscription(s.wire, "sessions.subscribe");
  return { ...s, adding, list };
};

const phase = (runtime: Runtime) => runtime.connections.list.read()[0]?.phase;
const freshness = (runtime: Runtime) => runtime.projections.sessionList.read().environments[0];
const rows = (runtime: Runtime) => runtime.projections.sessionList.read().rows.map((row) => row.summary.id);
const row = (runtime: Runtime, id: string): SessionSummary | undefined => runtime.projections.sessionList.read().rows.find((r) => r.summary.id === id)?.summary;
const cursorOf = (documents: InMemoryDocumentStore, environmentId: string) =>
  (documents.entries()[streamDocument(environmentId, "list")] as { sequence: number } | undefined)?.sequence;

describe("attaching", () => {
  it("subscribes the session list and the environment's stream once ready, from 0 with nothing cached", async () => {
    const { wire, list } = await paired();
    expect(list.params).toEqual({ afterSequence: 0 });
    const environment = await wire.server.request("environment.subscribe");
    expect(environment.params).toEqual({ afterSequence: 0 });
  });

  it("is syncing while the list catches up and ready once it is synchronized; add settles then", async () => {
    const { runtime, list, adding } = await paired();
    await flush();
    expect(phase(runtime)).toBe("syncing");
    expect(freshness(runtime)).toMatchObject({ freshness: "catching-up", fault: null });
    let settled = false;
    void adding.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    list.synchronized(0);
    await adding;
    expect(phase(runtime)).toBe("ready");
    expect(freshness(runtime)).toMatchObject({ freshness: "live" });
  });

  it("passes the cursor on the next attach, and renders from the cache before the environment answers", async () => {
    const clock = manualClock();
    const { documents } = recording();
    const first = await paired({ clock, documents });
    const a = randomUUID();
    first.list.event(sessionEvent(5, added(summaryOf(a))));
    first.list.synchronized(9);
    await first.adding;
    await first.runtime.close();

    const again = runtimeOn({ clock, documents, secrets: first.platform.secrets, wire: first.wire });
    const starting = again.runtime.start();
    await flush();
    // Before any socket: the cached list, `cached`.
    expect(rows(again.runtime)).toEqual([a]);
    expect(freshness(again.runtime)).toMatchObject({ freshness: "cached" });
    expect(again.runtime.connections.list.read()[0]?.unreachableSince).toBe(clock.now().toISOString());

    await again.wire.server.accept();
    const list = await subscription(again.wire, "sessions.subscribe");
    expect(list.params).toEqual({ afterSequence: 9 });
    await flush();
    expect(freshness(again.runtime)).toMatchObject({ freshness: "catching-up" });
    list.synchronized(9);
    await starting;
    expect(freshness(again.runtime)).toMatchObject({ freshness: "live" });
    expect(rows(again.runtime)).toEqual([a]);
  });
});

describe("applying", () => {
  it("applies duplicate sequences across catch-up and live once", async () => {
    const { runtime, list, adding } = await paired();
    const a = randomUUID();
    list.event(sessionEvent(3, added(summaryOf(a))));
    list.event(sessionEvent(4, { op: "set", sessionId: a, fields: { title: "Invoices" } }, "session.title-set"));
    list.synchronized(4);
    await adding;
    // The live feed repeats what catch-up sent.
    list.event(sessionEvent(4, { op: "set", sessionId: a, fields: { title: "Stale" } }, "session.title-set"));
    list.event(sessionEvent(3, { op: "remove", sessionId: a }, "session.deleted"));
    list.event(sessionEvent(5, { op: "set", sessionId: a, fields: { tags: ["wip"] } }, "session.tagged"));
    await flush();
    expect(row(runtime, a)).toMatchObject({ title: "Invoices", tags: ["wip"] });
  });

  it("replaces state and cursor whole on a snapshot", async () => {
    const clock = manualClock();
    const { documents } = recording();
    const { runtime, wire, list, adding } = await paired({ clock, documents });
    const [a, b] = [randomUUID(), randomUUID()];
    list.event(sessionEvent(10, added(summaryOf(a))));
    list.synchronized(10);
    await adding;
    wire.server.drop();
    await flush();
    clock.advance(1250);
    await wire.server.accept();

    const again = await subscription(wire, "sessions.subscribe");
    expect(again.params).toEqual({ afterSequence: 10 });
    again.snapshot(7, { sequence: 7, sessions: [summaryOf(b)], groups: [groupOf(randomUUID(), "Cool Jams")] });
    again.synchronized(7);
    await flush();
    expect(rows(runtime)).toEqual([b]);
    expect(runtime.projections.sessionList.read().groups.map((h) => h.name)).toEqual(["Cool Jams"]);
    expect(cursorOf(documents, wire.environmentId)).toBe(7);

    wire.server.drop();
    await flush();
    // The second failure in a row waits the ladder's second rung.
    clock.advance(2500);
    await wire.server.accept();
    expect((await subscription(wire, "sessions.subscribe")).params).toEqual({ afterSequence: 7 });
  });

  it("never advances the cursor on an apply that fails, and asks for a snapshot instead", async () => {
    const clock = manualClock();
    const { documents } = recording();
    const { runtime, wire, list, adding } = await paired({ clock, documents });
    const a = randomUUID();
    list.event(sessionEvent(3, added(summaryOf(a))));
    list.synchronized(3);
    await adding;
    expect(cursorOf(documents, wire.environmentId)).toBe(3);

    // A patch for a session this list does not hold: it cannot apply.
    list.event(sessionEvent(4, { op: "set", sessionId: randomUUID(), fields: { title: "x" } }, "session.title-set"));
    await flush();
    clock.advance(STREAM_WRITE_DEBOUNCE_MS * 4);
    await flush();
    expect(cursorOf(documents, wire.environmentId)).toBe(3);
    expect(freshness(runtime)).toMatchObject({ fault: expect.stringMatching(/could not be applied/) });
    expect(wire.server.received()).toContainEqual({ type: "unsubscribe", subscription: expect.any(String) });

    const recovery = await subscription(wire, "sessions.subscribe");
    expect(recovery.params["afterSequence"]).toBeGreaterThan(1_000_000);
    recovery.snapshot(4, { sequence: 4, sessions: [summaryOf(a, { title: "x" })], groups: [] });
    recovery.synchronized(4);
    await flush();
    expect(row(runtime, a)?.title).toBe("x");
    expect(freshness(runtime)).toMatchObject({ freshness: "live", fault: null });
    expect(cursorOf(documents, wire.environmentId)).toBe(4);
  });
});

describe("writing the cache", () => {
  it("writes cursor and snapshot in one set, forced on synchronized, debounced 500 ms otherwise, and forced on disconnect", async () => {
    const clock = manualClock();
    const { documents, sets } = recording();
    const { wire, list, adding } = await paired({ clock, documents });
    const key = streamDocument(wire.environmentId, "list");
    const writes = () => sets.filter(([k]) => k === key).map(([, v]) => v as { sequence: number; snapshot: { sessions: unknown[] } });
    const a = randomUUID();

    list.event(sessionEvent(2, added(summaryOf(a))));
    await flush();
    expect(writes()).toEqual([]);
    list.synchronized(2);
    await adding;
    expect(writes().map((w) => [w.sequence, w.snapshot.sessions.length])).toEqual([[2, 1]]);

    list.event(sessionEvent(3, { op: "set", sessionId: a, fields: { title: "one" } }, "session.title-set"));
    list.event(sessionEvent(4, { op: "set", sessionId: a, fields: { title: "two" } }, "session.title-set"));
    await flush();
    clock.advance(STREAM_WRITE_DEBOUNCE_MS - 1);
    await flush();
    expect(writes()).toHaveLength(1);
    clock.advance(1);
    await flush();
    expect(writes().map((w) => w.sequence)).toEqual([2, 4]);

    list.event(sessionEvent(5, { op: "set", sessionId: a, fields: { title: "three" } }, "session.title-set"));
    await flush();
    wire.server.drop();
    await flush();
    expect(writes().map((w) => w.sequence)).toEqual([2, 4, 5]);
  });
});

describe("ends and faults", () => {
  const overflowed = async () => {
    const s = await paired();
    s.list.event(sessionEvent(5, added(summaryOf(randomUUID()))));
    s.list.synchronized(5);
    await s.adding;
    return s;
  };

  it("resubscribes from the cursor at once on overflow, after one second on a second within a minute, then on the ladder", async () => {
    const { wire, clock, runtime, list } = await overflowed();
    list.end("overflow");
    const second = await subscription(wire, "sessions.subscribe");
    expect(second.params).toEqual({ afterSequence: 5 });
    await flush();
    expect(freshness(runtime)?.freshness).toBe("catching-up");
    second.synchronized(5);

    clock.advance(10_000);
    second.end("overflow");
    await flush();
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.subscribe")).toHaveLength(2);
    expect(freshness(runtime)?.freshness).toBe("cached");
    clock.advance(999);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.subscribe")).toHaveLength(2);
    clock.advance(251);
    const third = await subscription(wire, "sessions.subscribe");
    expect(third.params).toEqual({ afterSequence: 5 });

    // A third within the minute waits the ladder's next rung, two seconds and its jitter.
    third.end("overflow");
    await flush();
    clock.advance(1999);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.subscribe")).toHaveLength(3);
    clock.advance(501);
    const fourth = await subscription(wire, "sessions.subscribe");
    fourth.synchronized(5);
    await flush();

    // More than a minute after the last, an overflow is the first again.
    clock.advance(MINUTE + 1);
    fourth.end("overflow");
    expect((await subscription(wire, "sessions.subscribe")).params).toEqual({ afterSequence: 5 });
  });

  it("re-attaches after any other end on the next ready, not before", async () => {
    const { wire, clock, runtime, list } = await overflowed();
    list.end("closed");
    await flush();
    clock.advance(MINUTE);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.subscribe")).toHaveLength(1);
    expect(freshness(runtime)?.freshness).toBe("cached");

    const retrying = runtime.connections.retryNow(wire.environmentId);
    await wire.server.accept();
    const again = await subscription(wire, "sessions.subscribe");
    expect(again.params).toEqual({ afterSequence: 5 });
    again.synchronized(5);
    await retrying;
  });

  it("is a stream fault, never reconnecting, when a subscription fails on a healthy socket", async () => {
    const s = runtimeOn();
    s.wire.answer("sessions.subscribe", () => ({ error: { code: "forbidden", message: "This client session lacks the read scope.", data: { scope: "read" } } }));
    await s.runtime.start();
    const adding = s.runtime.connections.add({ link: s.wire.link });
    await s.wire.server.accept();
    await adding;

    expect(phase(s.runtime)).toBe("ready");
    expect(freshness(s.runtime)).toEqual({ environmentId: s.wire.environmentId, freshness: "empty", fault: "This client session lacks the read scope." });
    s.clock.advance(MINUTE);
    await flush();
    expect(s.wire.opened()).toBe(1);
    expect(phase(s.runtime)).toBe("ready");
  });

  it("is a stream fault when the environment does not answer a subscription within 30 seconds", async () => {
    const { runtime, clock, wire } = runtimeOn();
    await runtime.start();
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    await wire.server.request("sessions.subscribe");
    await flush();
    expect(phase(runtime)).toBe("syncing");
    clock.advance(SUBSCRIBE_TIMEOUT_MS);
    await flush();
    expect(phase(runtime)).toBe("ready");
    expect(freshness(runtime)).toMatchObject({ freshness: "empty", fault: expect.stringMatching(/did not answer/) });
    expect(wire.opened()).toBe(1);
    await adding;
  });
});

describe("session handles", () => {
  it("subscribe a session, and keep it five minutes after the last release", async () => {
    const { runtime, wire, clock, list, adding } = await paired();
    const a = randomUUID();
    list.event(sessionEvent(2, added(summaryOf(a))));
    list.synchronized(2);
    await adding;

    const handle = runtime.subscriptions.session(wire.environmentId, a.toUpperCase());
    const stream = await subscription(wire, "sessions.subscribeSession");
    expect(stream.params).toEqual({ sessionId: a, afterSequence: 0 });
    stream.snapshot(2, { sequence: 2, summary: summaryOf(a), transcript: {} });
    stream.synchronized(2);
    await flush();
    expect(handle.state.read()).toMatchObject({ freshness: "live", summary: { id: a }, deleted: false });
    stream.event(sessionEvent(3, { op: "set", sessionId: a, fields: { title: "Renamed" } }, "session.title-set"));
    await flush();
    expect(handle.state.read().summary?.title).toBe("Renamed");

    handle.release();
    handle.release();
    clock.advance(SESSION_LINGER_MS - 1);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "unsubscribe")).toEqual([]);
    // Opened again within the linger: the same subscription serves it.
    const again = runtime.subscriptions.session(wire.environmentId, a);
    again.release();
    clock.advance(SESSION_LINGER_MS - 1);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "unsubscribe")).toEqual([]);
    clock.advance(1);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "unsubscribe")).toHaveLength(1);
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.subscribeSession")).toHaveLength(1);
  });

  it("subscribe a held session again on the socket a re-pair in place brings", async () => {
    const { runtime, wire, list, adding } = await paired();
    const a = randomUUID();
    list.synchronized(0);
    await adding;
    const handle = runtime.subscriptions.session(wire.environmentId, a);
    const first = await subscription(wire, "sessions.subscribeSession");
    first.snapshot(4, { sequence: 4, summary: summaryOf(a), transcript: {} });
    first.synchronized(4);
    await flush();

    const repairing = runtime.connections.add({ link: wire.link }, { rePair: wire.environmentId });
    await wire.server.accept();
    const relisted = await subscription(wire, "sessions.subscribe");
    relisted.synchronized(4);
    const again = await subscription(wire, "sessions.subscribeSession");
    expect(again.params).toEqual({ sessionId: a, afterSequence: 4 });
    again.synchronized(4);
    expect(await repairing).toMatchObject({ status: "paired" });
    await flush();
    expect(handle.state.read()).toMatchObject({ freshness: "live", summary: { id: a } });
    handle.release();
  });

  it("drops a session its subscription ends as deleted, and its cached snapshot", async () => {
    const { documents } = recording();
    const { runtime, wire, clock, list, adding } = await paired({ documents });
    const a = randomUUID();
    list.synchronized(0);
    await adding;
    const handle = runtime.subscriptions.session(wire.environmentId, a);
    const stream = await subscription(wire, "sessions.subscribeSession");
    stream.snapshot(2, { sequence: 2, summary: summaryOf(a), transcript: {} });
    stream.synchronized(2);
    stream.event(sessionEvent(3, { op: "remove", sessionId: a }, "session.deleted"));
    stream.end("deleted");
    await flush();
    expect(handle.state.read()).toMatchObject({ deleted: true, summary: null });
    handle.release();
    clock.advance(SESSION_LINGER_MS);
    await flush();
    expect(documents.entries()[streamDocument(wire.environmentId, `session.${a}`)]).toBeUndefined();
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.subscribeSession")).toHaveLength(1);
  });
});

describe("offline", () => {
  it("reads the list and every cached session from their snapshots, cached", async () => {
    const clock = manualClock();
    const { documents } = recording();
    const first = await paired({ clock, documents });
    const a = randomUUID();
    first.list.event(sessionEvent(2, added(summaryOf(a, { title: "Invoices" }))));
    first.list.synchronized(2);
    await first.adding;
    const handle = first.runtime.subscriptions.session(first.wire.environmentId, a);
    const stream = await subscription(first.wire, "sessions.subscribeSession");
    stream.snapshot(2, { sequence: 2, summary: summaryOf(a, { title: "Invoices" }), transcript: { items: [] } });
    stream.synchronized(2);
    await flush();
    handle.release();
    await first.runtime.close();

    first.wire.discovery("unreachable");
    const again = runtimeOn({ clock, documents, secrets: first.platform.secrets, wire: first.wire, offline: true });
    await again.runtime.start();
    expect(rows(again.runtime)).toEqual([a]);
    expect(freshness(again.runtime)).toMatchObject({ freshness: "cached" });
    const offline = again.runtime.subscriptions.session(first.wire.environmentId, a);
    await flush();
    expect(offline.state.read()).toMatchObject({ freshness: "cached", summary: { title: "Invoices" } });
    offline.release();
  });
});

describe("removing an environment", () => {
  it("forgets its list, its sessions, its cursors and its clock", async () => {
    const clock = manualClock();
    const { documents } = recording();
    const { runtime, wire, list, adding } = await paired({ clock, documents });
    const a = randomUUID();
    list.event(sessionEvent(2, added(summaryOf(a))));
    list.synchronized(2);
    await adding;
    const handle = runtime.subscriptions.session(wire.environmentId, a);
    const stream = await subscription(wire, "sessions.subscribeSession");
    stream.snapshot(2, { sequence: 2, summary: summaryOf(a), transcript: {} });
    stream.synchronized(2);
    await flush();
    handle.release();
    expect(Object.keys(documents.entries()).filter((k) => k.startsWith(`streams.${wire.environmentId}.`)).sort()).toEqual(
      [`list`, `meta`, `session.${a}`].map((name) => streamDocument(wire.environmentId, name)).sort(),
    );

    await runtime.connections.remove(wire.environmentId);
    await flush();
    expect(Object.keys(documents.entries()).filter((k) => k.startsWith("streams."))).toEqual([]);
    expect(runtime.projections.sessionList.read()).toMatchObject({ environments: [], rows: [] });
  });
});

describe("the environment's stream and its clock", () => {
  it("takes the environment's time from hello, so a snooze past on its clock is awake", async () => {
    const s = runtimeOn();
    await s.runtime.start();
    const adding = s.runtime.connections.add({ link: s.wire.link });
    const ahead = new Date(s.clock.now().getTime() + 60 * MINUTE);
    await s.wire.server.accept({ serverTime: ahead.toISOString() });
    const list = await subscription(s.wire, "sessions.subscribe");
    const [woken, dozing] = [randomUUID(), randomUUID()];
    // Due in 30 minutes by this client's clock: past already by the environment's.
    list.event(sessionEvent(2, added(summaryOf(woken, { snoozedUntil: new Date(s.clock.now().getTime() + 30 * MINUTE).toISOString() }))));
    list.event(sessionEvent(3, added(summaryOf(dozing, { snoozedUntil: new Date(s.clock.now().getTime() + 90 * MINUTE).toISOString() }))));
    list.synchronized(3);
    await adding;

    expect(s.runtime.environmentNow(s.wire.environmentId).toISOString()).toBe(ahead.toISOString());
    const view = s.runtime.projections.sessionList.read();
    expect(view.active.map((r) => r.summary.id)).toEqual([woken]);
    expect(view.snoozed.map((r) => r.summary.id)).toEqual([dozing]);

    // It wakes on its own once the environment's clock passes it.
    const seen: string[][] = [];
    s.runtime.projections.sessionList.subscribe((v) => seen.push(v.snoozed.map((r) => r.summary.id)));
    s.clock.advance(30 * MINUTE);
    expect(s.runtime.projections.sessionList.read().snoozed).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
  });

  it("raises a notice for an update that is news, never for one replayed on the first attach", async () => {
    const { runtime, wire, list, adding } = await paired();
    list.synchronized(0);
    const environment = await subscription(wire, "environment.subscribe");
    environment.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    environment.synchronized(1);
    await adding;
    await flush();
    expect(runtime.projections.notices.read()).toEqual([]);

    environment.event(noticeEvent(2, wire.environmentId, "environment.updated", { fromVersion: "0.2.0", toVersion: "0.3.0" }));
    await flush();
    expect(runtime.projections.notices.read()).toEqual([
      expect.objectContaining({ environmentId: wire.environmentId, kind: "updated", message: "desk was updated from 0.2.0 to 0.3.0.", action: null }),
    ]);
  });
});
