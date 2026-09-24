import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntimeWithSeams } from "./internal.js";
import { REQUEST_TIMEOUT_MS } from "./requests.js";
import { fakeWire, flush } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * `requests.call` (docs/specs/client-runtime.md, "The offline outbox":
 * non-mutating calls and the `admin` calls, which are direct requests): never
 * queued, refused at once absent-with-reason when the connection cannot take
 * it, answered with the method's response checked against its schema, and
 * given up after 30 seconds. The request cache is #128's.
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
          ceiling: "top",
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
