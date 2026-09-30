import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { BYE_WAIT_MS } from "./connections/state-machine.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWireOptions } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * The `update-environment` action's call (launcher-update spec, "Across a
 * protocol gap"; #353), against a scripted fake environment: blocked
 * `protocol-mismatch` it posts `POST /api/update` with the client's version
 * and the connection shows `updating` through the restart until `hello`
 * agrees; otherwise it sends `updates.apply`; a refusal raises a notice
 * naming why.
 */

/** The version this client says it is, which the ask names. */
const CLIENT_VERSION = "0.6.0";

/** The client speaks one more than this build, so an environment on this build's is the older side of a mismatch. */
const CLIENT_PROTOCOL = PROTOCOL_VERSION + 1;

const record = (runtime: Runtime) => {
  const [only] = runtime.connections.list.read();
  if (!only) throw new Error("No connection is listed.");
  return only;
};

/** A runtime paired with a fake environment that is older than it and says it can update itself, blocked `protocol-mismatch`. */
const blocked = async (wireOptions: Partial<Omit<FakeWireOptions, "clock">> = {}) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"], ...wireOptions });
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, version: CLIENT_VERSION });
  const { runtime } = createRuntimeWithSeams(platform, { protocolVersion: CLIENT_PROTOCOL });
  onTestFinished(() => runtime.close());
  const starting = runtime.start();
  await starting;
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  expect(await adding).toMatchObject({ status: "paired" });
  wire.discovery({ protocolVersion: PROTOCOL_VERSION, capabilities: ["self-update"] });
  await runtime.connections.retryNow(wire.environmentId);
  expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  return { clock, wire, platform, runtime };
};

/** A runtime paired with a fake environment on its own protocol, ready. */
const ready = async () => {
  const clock = manualClock();
  const wire = fakeWire({ clock });
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, version: CLIENT_VERSION });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  await adding;
  expect(record(runtime).phase).toBe("ready");
  return { clock, wire, runtime };
};

const notices = (runtime: Runtime) => runtime.projections.notices.read().filter((notice) => notice.kind === "update-refused");

describe("update-environment while blocked protocol-mismatch", () => {
  it("posts the route with the client session's token and the client's version, and the connection shows updating through the restart until hello agrees", async () => {
    const { clock, wire, runtime } = await blocked();
    const token = wire.credential()?.token;
    const blockNotices = runtime.projections.notices.read().length;

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: true, updateId: expect.any(String) as unknown as string, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token, body: { version: CLIENT_VERSION } }]);
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null });
    expect(notices(runtime)).toEqual([]);

    // The old environment still answers while a run keeps it from restarting: still updating, polled on, nothing raised.
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null });
    // The restart: nothing answers for a while, and starting.
    wire.discovery("unreachable");
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime).phase).toBe("updating");
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, readiness: "starting", capabilities: ["self-update"] });
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime).phase).toBe("updating");

    // The new version is up: hello agrees, and the block is cleared.
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, harnessVersion: CLIENT_VERSION, capabilities: ["self-update"] });
    clock.advance(BYE_WAIT_MS);
    await wire.server.accept({ protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"] });
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready", blocked: null, action: null, descriptor: { harnessVersion: CLIENT_VERSION } });
    expect(runtime.projections.notices.read()).toHaveLength(blockNotices);
    // It was the route that asked, never the wire: the only socket the fake opened after the pairing is the one that reached ready.
    expect(wire.updatePosts()).toHaveLength(1);
  });

  it("keeps the block across a restart of this client mid-update, and clears it when hello agrees", async () => {
    const { wire, platform, clock, runtime } = await blocked();
    await runtime.connections.updateEnvironment(wire.environmentId);
    await runtime.close();

    const again = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: platform.documents, secrets: platform.secrets, version: CLIENT_VERSION }), {
      protocolVersion: CLIENT_PROTOCOL,
    }).runtime;
    onTestFinished(() => again.close());
    await again.start();
    // The old environment still answers: a re-check finds the block again, and the action to ask once more.
    expect(record(again)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
  });

  it.each([
    [409, { code: "conflict", message: "This environment runs 0.6.0 already.", data: { reason: "current" } }, "current"],
    [403, { code: "forbidden", message: "Only a local client session may name an artefact path.", data: { scope: "admin", reason: "local" } }, "local"],
    [403, { code: "forbidden", message: "Updating the environment needs the admin scope, which this client session does not hold.", data: { scope: "admin" } }, "forbidden"],
    [401, { code: "unauthorized", message: "The client session was revoked.", data: {} }, "unauthorized"],
    [404, { code: "not_found", message: "No release 0.6.0 is published.", data: {} }, "not_found"],
    [503, { code: "unavailable", message: "The environment is draining; try again once it is ready.", data: { readiness: "draining" } }, "unavailable"],
  ] as const)("raises a notice naming why when the environment refuses with %s %s", async (status, error, reason) => {
    const { wire, runtime } = await blocked();
    wire.updateRoute({ status, body: error });

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: false, refused: true, reason, message: error.message });
    expect(notices(runtime)).toEqual([
      expect.objectContaining({ environmentId: wire.environmentId, action: null, message: `fake refused the update to ${CLIENT_VERSION} (${reason}): ${error.message}` }),
    ]);
    // Still blocked, and the action is still offered to ask again.
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  });

  it("says nothing is refused when the ask never reaches the environment or its answer is none the route gives, and stays blocked", async () => {
    const { wire, runtime } = await blocked();
    wire.updateRoute("unreachable");
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "unreachable" });

    wire.updateRoute({ status: 200, body: { updateId: "not a uuid" } });
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "malformed" });
    wire.updateRoute({ status: 502, body: "<html>bad gateway</html>" });
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "malformed" });

    expect(notices(runtime)).toEqual([]);
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
    expect(wire.updatePosts()).toHaveLength(3);
  });

  it("rejects for an environment it has no connection to", async () => {
    const { runtime } = await blocked();
    await expect(runtime.connections.updateEnvironment("no-such-environment")).rejects.toThrow("no saved connection");
  });
});

describe("update-environment otherwise", () => {
  it("sends updates.apply on the socket with the client's version and when idle, never the route, and follows bye: updating", async () => {
    const { wire, runtime, clock } = await ready();
    wire.answer("updates.apply", (params) => ({
      result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { updateId: "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f", toVersion: params["version"] } },
    }));

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: true, updateId: "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f", toVersion: CLIENT_VERSION });
    const [sent] = wire.server.received().filter((frame) => frame.type === "request" && frame.method === "updates.apply");
    expect(sent).toMatchObject({ params: { version: CLIENT_VERSION, when: "idle", commandId: expect.any(String) as unknown } });
    expect(wire.updatePosts()).toEqual([]);

    wire.server.bye("updating");
    await flush();
    expect(record(runtime).phase).toBe("updating");
    wire.discovery({ harnessVersion: CLIENT_VERSION });
    clock.advance(BYE_WAIT_MS);
    await wire.server.accept();
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready", descriptor: { harnessVersion: CLIENT_VERSION } });
  });

  it("raises the notice naming why when the receipt rejects it, and when the request itself is refused", async () => {
    const { wire, runtime } = await ready();
    wire.answer("updates.apply", () => ({
      result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "The update to 0.6.0 is draining; it cannot be changed now.", data: { reason: "in_progress" } } } },
    }));
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: true, reason: "in_progress" });
    expect(notices(runtime)).toEqual([expect.objectContaining({ message: `fake refused the update to ${CLIENT_VERSION} (in_progress): The update to 0.6.0 is draining; it cannot be changed now.` })]);

    wire.answer("updates.apply", () => ({ error: { code: "forbidden", message: "updates.apply needs the admin scope, which this client session does not hold.", data: { scope: "admin" } } }));
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: true, reason: "forbidden" });
    expect(notices(runtime)).toHaveLength(2);
  });

  it("is no refusal when there is no socket to ask on", async () => {
    const { wire, runtime } = await ready();
    wire.server.drop();
    await flush();
    expect(record(runtime).phase).not.toBe("ready");
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "unreachable" });
    expect(notices(runtime)).toEqual([]);
  });
});
