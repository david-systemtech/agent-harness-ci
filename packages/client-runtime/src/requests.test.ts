import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntimeWithSeams } from "./internal.js";
import { noticeEvent } from "../test/events.js";
import { subscription } from "../test/scripted.js";
import { createRequestCache, REQUEST_CACHE_TTL_MS, REQUEST_TIMEOUT_MS } from "./requests.js";
import { writable } from "./observable.js";
import type { ConnectionRecord } from "./connections/records.js";
import { fakeWire, flush } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * `requests.call` (docs/specs/client-runtime.md, "The offline outbox":
 * non-mutating calls and the `admin` calls, which are direct requests): never
 * queued, refused at once absent-with-reason when the connection cannot take
 * it, answered with the method's response checked against its schema, and
 * given up after 30 seconds; and the request cache (#128), which keeps a
 * query's answer five minutes and fetches it again on ready and on the
 * notice that says it may have changed.
 */

const paired = async (hello: Parameters<ReturnType<typeof fakeWire>["server"]["accept"]>[0] = {}) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "box" });
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept(hello);
  expect(await adding).toMatchObject({ status: "paired" });
  return { clock, wire, runtime, id: wire.environmentId };
};

describe("requests.call", () => {
  it("answers a query with its result, checked against the method's schema", async () => {
    const { runtime, id } = await paired();
    expect(await runtime.requests.call(id, "environment.status", {})).toEqual({
      ok: true,
      result: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false },
    });
  });

  it("answers a command with its receipt beside its result", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("access.pairings.create", () => ({
      result: {
        receipt: { status: "accepted", sequence: 4, changed: true },
        result: {
          pairingId: "0199aa00-0000-7000-8000-000000000001",
          code: "K7Q2MXH4RT",
          link: "http://fake.test:7433/pair#K7Q2MXH4RT",
          expiresAt: "2026-09-24T00:10:00.000Z",
          scopes: ["read"],
          ceiling: "bypassPermissions",
        },
      },
    }));
    const answer = await runtime.requests.call(id, "access.pairings.create", { commandId: "0199aa00-0000-7000-8000-0000000000aa" });
    expect(answer).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { code: "K7Q2MXH4RT" } } });
    expect(wire.server.received().filter((f) => f.type === "request").map((f) => (f as { method: string }).method)).toContain("access.pairings.create");
  });

  it("passes the environment's error on as it is", async () => {
    const { runtime, id } = await paired();
    const answer = await runtime.requests.call(id, "groups.list", {});
    expect(answer).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses at once, sending nothing, when the connection is not ready", async () => {
    const { runtime, wire, id } = await paired();
    wire.server.drop();
    await flush();
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "environment.status", {});
    expect(answer).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(wire.server.received().length).toBe(before);
  });

  it("refuses at once as unreachable while the connection is on its way back, not yet ready", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.server.drop();
    await flush();
    clock.advance(1250);
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("connecting");
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "environment.status", {});
    expect(answer).toEqual({ ok: false, error: { code: "unreachable", message: "Connecting to box." } });
    expect(wire.server.received().length).toBe(before);
  });

  it("refuses an environment it has no connection to", async () => {
    const { runtime } = await paired();
    expect(await runtime.requests.call("0199aa00-0000-7000-8000-00000000dead", "environment.status", {})).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
  });

  it("refuses a method whose scope the client session lacks, with the capability's line", async () => {
    const { runtime, id } = await paired({ scopes: ["read"] });
    const answer = await runtime.requests.call(id, "access.sessions.list", {});
    expect(answer).toEqual({ ok: false, error: { code: "scope", message: expect.stringContaining("admin") } });
  });

  it("refuses params that are not the method's, sending nothing", async () => {
    const { runtime, wire, id } = await paired();
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "access.sessions.revoke", { commandId: "not a uuid", clientSessionId: "x" } as never);
    expect(answer).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(wire.server.received().length).toBe(before);
  });

  it("refuses a stream: subscriptions are the runtime's own", async () => {
    const { runtime, id } = await paired();
    expect(await runtime.requests.call(id, "sessions.subscribe", { afterSequence: 0 })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("refuses a sessions:write command, sending nothing: every one goes through the outbox", async () => {
    const { runtime, wire, id } = await paired();
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "sessions.archive", {
      commandId: "0199aa00-0000-7000-8000-0000000000ab",
      sessionId: "0199aa00-0000-4000-8000-000000000001",
    });
    expect(answer).toEqual({ ok: false, error: { code: "outbox", message: expect.stringContaining("sessions:write") } });
    expect(wire.server.received().length).toBe(before);
  });

  it("calls an answer that does not match the method's schema malformed", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("access.sessions.list", () => ({ result: { sessions: "none" } }));
    expect(await runtime.requests.call(id, "access.sessions.list", {})).toMatchObject({ ok: false, error: { code: "malformed" } });
  });

  it("gives up after 30 seconds without an answer", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("access.sessions.list", () => undefined);
    let settled: unknown;
    void runtime.requests.call(id, "access.sessions.list", {}).then((answer) => (settled = answer));
    await flush();
    clock.advance(REQUEST_TIMEOUT_MS - 1);
    await flush();
    expect(settled).toBeUndefined();
    clock.advance(1);
    await flush();
    expect(settled).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("answers unreachable when the socket closes before the answer", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("access.sessions.list", () => undefined);
    const answer = runtime.requests.call(id, "access.sessions.list", {});
    await flush();
    wire.server.drop();
    expect(await answer).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });
});

describe("the request cache", () => {
  /** A runtime paired with the fake wire, counting the `groups.list` requests it sends. */
  const counting = async (setup: { readonly environmentStream?: boolean } = {}) => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "box" });
    let asked = 0;
    wire.answer("groups.list", () => {
      asked++;
      return { result: { groups: [] } };
    });
    if (setup.environmentStream) wire.answer("environment.subscribe", () => undefined);
    const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
    const { runtime } = createRuntimeWithSeams(platform);
    onTestFinished(() => runtime.close());
    await runtime.start();
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    const environment = setup.environmentStream ? await subscription(wire, "environment.subscribe") : undefined;
    environment?.synchronized(0);
    expect(await adding).toMatchObject({ status: "paired" });
    return { clock, wire, runtime, id: wire.environmentId, asked: () => asked, environment };
  };

  it("fetches a query when first followed, and answers every follower from it for five minutes", async () => {
    const { clock, runtime, id, asked } = await counting();
    const cached = runtime.requests.cached(id, "groups.list", {});
    expect(cached.read()).toEqual({ result: null, fetchedAt: null, error: null, loading: false });
    expect(asked()).toBe(0);

    const stop = cached.subscribe(() => undefined);
    expect(cached.read().loading).toBe(true);
    await flush();
    expect(cached.read()).toEqual({ result: { groups: [] }, fetchedAt: clock.now().toISOString(), error: null, loading: false });
    expect(runtime.requests.cached(id, "groups.list", {})).toBe(cached);
    const again = runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);

    clock.advance(REQUEST_CACHE_TTL_MS - 1);
    await flush();
    expect(asked()).toBe(1);
    clock.advance(1);
    await flush();
    expect(asked()).toBe(2);

    // Followed by nobody, it is not fetched again until someone follows it once more.
    stop();
    again();
    clock.advance(REQUEST_CACHE_TTL_MS * 2);
    await flush();
    expect(asked()).toBe(2);
    cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(3);
    expect(REQUEST_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it("keeps the last result beside the failure while the environment cannot be reached, and fetches again on ready", async () => {
    const { clock, wire, runtime, id, asked } = await counting();
    const cached = runtime.requests.cached(id, "groups.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    // The five minutes run out with no socket: the answer is unreachable at once, and the last result stays.
    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    expect(asked()).toBe(1);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, error: { code: "unreachable" }, loading: false });

    wire.discovery({});
    void runtime.connections.retryNow(id);
    await wire.server.accept();
    await flush();
    expect(asked()).toBe(2);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, error: null });
  });

  it("fetches again on a notice that the environment restarted or was updated", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);
    environment?.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    expect(asked()).toBe(2);
    environment?.event(noticeEvent(2, wire.environmentId, "environment.draining", { drainingSince: "2026-09-24T00:00:00.000Z" }));
    await flush();
    expect(asked()).toBe(2);
  });

  it("fetches once more after a fetch asked for again while under way only while followed, and never for five minutes running out during it", async () => {
    const { clock, wire, runtime, id, asked, environment } = await counting({ environmentStream: true });
    const cached = runtime.requests.cached(id, "groups.list", {});
    let stop = cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);

    // From now on each answer is held until the test lets it go.
    let held = 0;
    let release = () => undefined as void;
    wire.answer("groups.list", () => {
      held++;
      return new Promise((resolve) => (release = () => resolve({ result: { groups: [] } })));
    });

    // A notice fetches before the five minutes are out, and they run out while that fetch is under way: that is not a second
    // ask, so its answer is the only one sent, and the next comes five minutes after it.
    clock.advance(REQUEST_CACHE_TTL_MS - 1_000);
    environment?.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    expect(held).toBe(1);
    clock.advance(1_000);
    await flush();
    release();
    await flush();
    expect(held).toBe(1);
    expect(cached.read()).toMatchObject({ loading: false, error: null });
    stop();

    // Followed, let go, followed and let go again while a fetch is under way: the second ask is not sent for nobody either,
    // but the answer counts as stale, so the next follower fetches it.
    clock.advance(REQUEST_CACHE_TTL_MS);
    stop = cached.subscribe(() => undefined);
    await flush();
    expect(held).toBe(2);
    stop();
    stop = cached.subscribe(() => undefined);
    stop();
    release();
    await flush();
    expect(held).toBe(2);
    cached.subscribe(() => undefined);
    await flush();
    expect(held).toBe(3);
  });

  it("stops loading when the environment is removed or the runtime closes with a fetch under way", async () => {
    const hold = async () => {
      const setup = await counting();
      setup.wire.answer("groups.list", () => new Promise(() => undefined));
      const cached = setup.runtime.requests.cached(setup.id, "groups.list", {});
      cached.subscribe(() => undefined);
      await flush();
      expect(cached.read().loading).toBe(true);
      return { ...setup, cached };
    };

    const removed = await hold();
    await removed.runtime.connections.remove(removed.id);
    await flush();
    expect(removed.cached.read().loading).toBe(false);

    const closed = await hold();
    await closed.runtime.close();
    await flush();
    expect(closed.cached.read().loading).toBe(false);
  });

  it("says when the fetch whose result it holds was sent, which a failed fetch after it does not move", async () => {
    const clock = manualClock();
    const answers: ((answer: unknown) => void)[] = [];
    const cache = createRequestCache({
      clock,
      call: () => new Promise((resolve) => answers.push(resolve)) as never,
      records: writable<readonly ConnectionRecord[]>([]),
      report: () => undefined,
    });
    onTestFinished(() => cache.close());
    const cached = cache.cached("env-1", "groups.list", {});
    expect(cache.askedAt("env-1", "groups.list", {})).toBeNull();
    const sent = clock.now().getTime();
    onTestFinished(cached.subscribe(() => undefined));
    clock.advance(500);
    answers[0]!({ ok: true, result: { groups: [] } });
    await flush();
    expect(cached.read().fetchedAt).toBe(new Date(sent + 500).toISOString());
    expect(cache.askedAt("env-1", "groups.list", {})).toBe(sent);

    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    answers[1]!({ ok: false, error: { code: "unreachable", message: "The environment cannot be reached." } });
    await flush();
    expect(cached.read()).toMatchObject({ result: { groups: [] }, error: { code: "unreachable" } });
    expect(cache.askedAt("env-1", "groups.list", {})).toBe(sent);
  });

  it("is not left in flight by a call that rejects: the failure is reported, loading ends, and the next follower fetches again", async () => {
    const clock = manualClock();
    const reported: unknown[] = [];
    let calls = 0;
    const cache = createRequestCache({
      clock,
      call: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("the host broke")) : Promise.resolve({ ok: true, result: { groups: [] } } as never);
      },
      records: writable<readonly ConnectionRecord[]>([]),
      report: (error) => reported.push(error),
    });
    onTestFinished(() => cache.close());
    const cached = cache.cached("env-1", "groups.list", {});
    const stop = cached.subscribe(() => undefined);
    await flush();
    expect(reported).toEqual([new Error("the host broke")]);
    expect(cached.read().loading).toBe(false);
    stop();

    cached.subscribe(() => undefined);
    await flush();
    expect(calls).toBe(2);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, loading: false, error: null });
  });

  it("keeps a call that rejected beside the last result as a failure, and tries it again five minutes on while followed", async () => {
    const clock = manualClock();
    const reported: unknown[] = [];
    let calls = 0;
    const cache = createRequestCache({
      clock,
      call: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("the host broke")) : Promise.resolve({ ok: true, result: { groups: [] } } as never);
      },
      records: writable<readonly ConnectionRecord[]>([]),
      report: (error) => reported.push(error),
    });
    onTestFinished(() => cache.close());
    const cached = cache.cached("env-1", "groups.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(reported).toEqual([new Error("the host broke")]);
    expect(cached.read()).toMatchObject({ result: null, loading: false, error: { code: "internal", message: "the host broke" } });

    clock.advance(REQUEST_CACHE_TTL_MS - 1);
    await flush();
    expect(calls).toBe(1);
    clock.advance(1);
    await flush();
    expect(calls).toBe(2);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, loading: false, error: null });
  });

  it("is not moved by a caller changing its params object after the call: the entry keeps sending what it was given", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    const params: Record<string, unknown> = {};
    const cached = runtime.requests.cached(id, "groups.list", params as never);
    cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);
    params["changed"] = "later";
    environment?.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    expect(asked()).toBe(2);
    expect(cached.read().loading).toBe(false);
    expect(wire.server.received().flatMap((f) => (f.type === "request" && f.method === "groups.list" ? [f.params] : []))).toEqual([{}, {}]);
  });

  it("keeps one answer per params, and none for what is not a query", async () => {
    const { runtime, id } = await counting();
    expect(runtime.requests.cached(id, "settings.get", { keys: ["sessions.autoSettleOnMerge"] })).not.toBe(
      runtime.requests.cached(id, "settings.get", { keys: ["sessions.autoSettleAfterIdle"] }),
    );
    const command = runtime.requests.cached(id, "sessions.archive" as never, {} as never);
    command.subscribe(() => undefined);
    await flush();
    expect(command.read()).toMatchObject({ result: null, error: { code: "unsupported" } });
  });
});
