import { describe, expect, it } from "vitest";
import type { DocumentStore } from "../platform.js";
import { inMemoryDocuments, manualClock } from "../testing/in-memory-platform.js";
import {
  RETAINED_BYTES,
  RETAINED_SESSIONS,
  STREAM_WRITE_DEBOUNCE_MS,
  createRetention,
  createStreamCache,
  metaDocument,
  streamDocument,
  utf8Length,
  type CachedPair,
} from "./cache.js";

/**
 * The cursor cache (docs/specs/client-runtime.md, "Subscriptions, cursor
 * cache and snapshots"): one document per stream holding its cursor and the
 * snapshot it belongs to, written in one `set`, debounced 500 ms on the
 * platform clock and forced when asked; and the retention of session
 * snapshots. Durability is the behaviour here, so these tests read the
 * documents.
 */

/** A document store that records every `set` and can be made to fail. */
const recording = () => {
  const store = inMemoryDocuments();
  const sets: [string, unknown][] = [];
  let failing = false;
  const documents: DocumentStore = {
    get: (key) => store.get(key),
    async set(key, value) {
      if (failing) throw new Error("The disk is full.");
      sets.push([key, value]);
      await store.set(key, value);
    },
    delete: (key) => store.delete(key),
  };
  return { store, documents, sets, fail: (on: boolean) => void (failing = on) };
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the stream cache", () => {
  it("names one document per stream", () => {
    expect(streamDocument("env", "list")).toBe("streams.env.list");
    expect(streamDocument("env", "session.abc")).toBe("streams.env.session.abc");
    expect(metaDocument("env")).toBe("streams.env.meta");
  });

  it("writes the cursor and its snapshot together in one set, debounced 500 ms, with the latest committed pair", async () => {
    const clock = manualClock();
    const { documents, sets } = recording();
    const reported: unknown[] = [];
    const cache = createStreamCache({ documents, clock, report: (e) => reported.push(e) });
    let pair: CachedPair = { cursor: 1, snapshot: { n: 1 } };
    const key = streamDocument("env", "list");

    cache.soon(key, () => pair);
    pair = { cursor: 2, snapshot: { n: 2 } };
    cache.soon(key, () => pair);
    clock.advance(STREAM_WRITE_DEBOUNCE_MS - 1);
    await settle();
    expect(sets).toEqual([]);

    clock.advance(1);
    await settle();
    expect(sets).toEqual([[key, { format: 1, sequence: 2, snapshot: { n: 2 } }]]);
    expect(await cache.read(key)).toEqual({ cursor: 2, snapshot: { n: 2 } });
    expect(reported).toEqual([]);
  });

  it("writes at once when forced, dropping the pending debounce, and flushes whatever is pending", async () => {
    const clock = manualClock();
    const { documents, sets } = recording();
    const cache = createStreamCache({ documents, clock, report: () => undefined });
    const list = streamDocument("env", "list");
    const other = streamDocument("env", "environment");
    const elsewhere = streamDocument("far", "list");

    cache.soon(list, () => ({ cursor: 3, snapshot: {} }));
    await cache.now(list, () => ({ cursor: 4, snapshot: {} }));
    clock.advance(STREAM_WRITE_DEBOUNCE_MS);
    await settle();
    expect(sets.map(([, v]) => (v as { sequence: number }).sequence)).toEqual([4]);

    cache.soon(other, () => ({ cursor: 9, snapshot: {} }));
    cache.soon(elsewhere, () => ({ cursor: 1, snapshot: {} }));
    await cache.flush("env");
    expect(sets.map(([k]) => k)).toEqual([list, other]);
    await cache.flush();
    expect(sets.map(([k]) => k)).toEqual([list, other, elsewhere]);
  });

  it("writes nothing for a stream holding nothing, and never writes an older pair over a newer one", async () => {
    const clock = manualClock();
    const { documents, sets } = recording();
    const cache = createStreamCache({ documents, clock, report: () => undefined });
    const key = streamDocument("env", "list");
    await cache.now(key, () => null);
    expect(sets).toEqual([]);

    let pair: CachedPair = { cursor: 1, snapshot: {} };
    const first = cache.now(key, () => pair);
    pair = { cursor: 2, snapshot: {} };
    const second = cache.now(key, () => pair);
    await Promise.all([first, second]);
    expect(await cache.read(key)).toEqual({ cursor: 2, snapshot: {} });
  });

  it("reports a write that fails and keeps the old pair; the next write goes ahead", async () => {
    const clock = manualClock();
    const { documents, fail } = recording();
    const reported: unknown[] = [];
    const cache = createStreamCache({ documents, clock, report: (e) => reported.push(e) });
    const key = streamDocument("env", "list");
    await cache.now(key, () => ({ cursor: 1, snapshot: { a: 1 } }));

    fail(true);
    await cache.now(key, () => ({ cursor: 2, snapshot: { a: 2 } }));
    expect(reported).toHaveLength(1);
    expect(await cache.read(key)).toEqual({ cursor: 1, snapshot: { a: 1 } });

    fail(false);
    await cache.now(key, () => ({ cursor: 3, snapshot: { a: 3 } }));
    expect(await cache.read(key)).toEqual({ cursor: 3, snapshot: { a: 3 } });
  });

  it("reads a document it cannot understand as nothing cached", async () => {
    const { documents, store } = recording();
    const cache = createStreamCache({ documents, clock: manualClock(), report: () => undefined });
    await store.set("streams.env.list", { format: 99, sequence: "x" });
    expect(await cache.read("streams.env.list")).toBeUndefined();
    expect(await cache.read("streams.env.environment")).toBeUndefined();
  });

  it("counts a document's bytes as UTF-8", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
  });
});

describe("retention", () => {
  const setUp = async (held: ReadonlySet<string> = new Set()) => {
    const clock = manualClock();
    const { documents, store } = recording();
    const retention = createRetention({ documents, clock, report: () => undefined, held: (_env, id) => held.has(id) });
    await retention.load("env");
    // Every session's snapshot exists, and so does the list's, which retention never touches.
    await store.set(streamDocument("env", "list"), { format: 1, sequence: 1, snapshot: {} });
    return { clock, store, retention };
  };

  const open = async (setup: Awaited<ReturnType<typeof setUp>>, id: string, bytes = 10) => {
    await setup.store.set(streamDocument("env", `session.${id}`), { format: 1, sequence: 1, snapshot: {} });
    await setup.retention.opened("env", id);
    await setup.retention.wrote("env", id, bytes);
    setup.clock.advance(1000);
  };

  it("keeps the 50 most recently opened session snapshots, evicting the least recently opened, and always the list", async () => {
    const setup = await setUp();
    for (let i = 0; i < RETAINED_SESSIONS; i++) await open(setup, `s${i}`);
    // Opening s0 again makes s1 the least recent.
    await setup.retention.opened("env", "s0");
    await open(setup, "s50");

    const kept = Object.keys(setup.store.entries()).filter((k) => k.includes(".session."));
    expect(kept).toHaveLength(RETAINED_SESSIONS);
    expect(kept).not.toContain(streamDocument("env", "session.s1"));
    expect(kept).toContain(streamDocument("env", "session.s0"));
    expect(setup.store.entries()[streamDocument("env", "list")]).toBeDefined();
    expect(setup.retention.sessions("env")[0]).toBe("s50");
  });

  it("keeps them under 32 MiB, evicting the least recently opened first", async () => {
    const setup = await setUp();
    const third = Math.floor(RETAINED_BYTES / 3);
    await open(setup, "old", third);
    await open(setup, "mid", third);
    await open(setup, "new", third);
    expect(Object.keys(setup.store.entries()).filter((k) => k.includes(".session."))).toHaveLength(3);

    await setup.retention.wrote("env", "new", third + 10);
    const kept = Object.keys(setup.store.entries()).filter((k) => k.includes(".session."));
    expect(kept.sort()).toEqual([streamDocument("env", "session.mid"), streamDocument("env", "session.new")].sort());
  });

  it("never evicts a session a handle holds", async () => {
    const setup = await setUp(new Set(["s0"]));
    for (let i = 0; i <= RETAINED_SESSIONS; i++) await open(setup, `s${i}`);
    const kept = Object.keys(setup.store.entries()).filter((k) => k.includes(".session."));
    expect(kept).toContain(streamDocument("env", "session.s0"));
    expect(kept).not.toContain(streamDocument("env", "session.s1"));
  });

  it("keeps the environment's clock skew and its opened sessions across a load", async () => {
    const setup = await setUp();
    await open(setup, "a");
    await setup.retention.setSkew("env", 1500);
    const again = createRetention({ documents: { get: setup.store.get, set: setup.store.set, delete: setup.store.delete }, clock: setup.clock, report: () => undefined, held: () => false });
    await again.load("env");
    expect(again.skew("env")).toBe(1500);
    expect(again.sessions("env")).toEqual(["a"]);
  });

  it("forgets a session, and everything of an environment", async () => {
    const setup = await setUp();
    await open(setup, "a");
    await open(setup, "b");
    await setup.retention.removed("env", "a");
    expect(setup.retention.sessions("env")).toEqual(["b"]);
    expect(setup.store.entries()[streamDocument("env", "session.a")]).toBeUndefined();
    await setup.retention.forget("env");
    expect(Object.keys(setup.store.entries()).filter((k) => k.startsWith("streams.env."))).toEqual([]);
  });
});
