import { describe, expect, it } from "vitest";
import { bankRecord } from "../test/banks.js";
import { noticeEvent } from "../test/events.js";
import { usePaired } from "../test/paired.js";
import { subscription } from "../test/scripted.js";
import { REQUEST_CACHE_TTL_MS } from "./requests.js";
import { flush } from "./testing/fake-wire.js";

const { paired } = usePaired();

describe("bank records in the environment request cache", () => {
  it("shares the cached records, refreshes status and counts on bank.updated, and fetches again on reconnect", async () => {
    const { runtime, wire, env, environment, clock, kept } = await paired({ capabilities: ["banks"] });
    let bank = bankRecord();
    let asked = 0;
    wire.answer("banks.list", () => (asked++, { result: { banks: [bank] } }));
    const cached = runtime.requests.cached(env, "banks.list", {});
    expect(runtime.requests.cached(env, "banks.list", {})).toBe(cached);
    cached.subscribe(() => undefined);
    await flush();
    expect(cached.read()).toMatchObject({ result: { banks: [bank] }, error: null, loading: false });
    expect(asked).toBe(1);
    bank = bankRecord({ ...bank, memories: 9, folders: 3, status: { ...bank.status, landing: { state: "failed", step: "push", reason: "The target forge refused the push.", since: clock.now().toISOString() } } });
    environment.event(noticeEvent(1, env, "bank.updated", { bankId: bank.id, status: bank.status }));
    await flush();
    expect(cached.read().result?.banks[0]).toMatchObject({ memories: 9, folders: 3, status: { landing: { state: "failed" } } });
    expect(asked).toBe(2);
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    expect(cached.read()).toMatchObject({ result: { banks: [bank] }, error: { code: "unreachable" }, loading: false });
    bank = bankRecord({ ...bank, memories: 11 });
    wire.discovery({});
    void runtime.connections.retryNow(env);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    (await subscription(wire, "environment.subscribe")).synchronized(1);
    await flush();
    expect(cached.read()).toMatchObject({ result: { banks: [bank] }, error: null });
    expect(asked).toBe(3);
    expect(kept()).not.toContain(bank.checkout);
  });

  it("refuses the cache read without banks capability and sends no bank request", async () => {
    const { runtime, wire, env } = await paired({ capabilities: [] });
    const before = wire.server.received().length;
    const cached = runtime.requests.cached(env, "banks.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(cached.read()).toMatchObject({ result: null, error: { code: "unsupported" }, loading: false });
    expect(wire.server.received()).toHaveLength(before);
  });
});
