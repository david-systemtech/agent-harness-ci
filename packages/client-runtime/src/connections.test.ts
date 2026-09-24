import { randomUUID } from "node:crypto";
import { Ceiling, PROTOCOL_VERSION, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { HARNESS_VERSION } from "../../environment/src/serve/start.js";
import { failingFetch, originOf, recordingWebSocket, rewritingWebSocket, until, useHarness } from "../test/harness.js";
import type { Runtime } from "./runtime.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

const only = (runtime: Runtime) => {
  const [record, ...rest] = runtime.connections.list.read();
  if (!record || rest.length > 0) throw new Error(`Expected one connection, found ${runtime.connections.list.read().length}.`);
  return record;
};

describe("hello", () => {
  it("fills the scopes, ceiling, flags and name, and the discovery document the harness version", async () => {
    const t = await harness.environment({ name: "desk" });
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    const scopes: Scope[] = ["read", "sessions:write"];
    const { link } = await t.createPairing({ scopes, ceiling: Ceiling.parse("plan") });

    await runtime.connections.add({ link });

    expect(only(runtime)).toMatchObject({
      scopes,
      ceiling: "plan",
      descriptor: {
        name: "desk",
        icon: null,
        colour: null,
        harnessVersion: HARNESS_VERSION,
        protocolVersion: 1,
        capabilities: [],
        lastSeen: platform.clock.now().toISOString(),
      },
    });
  });

  it("takes the capability flags hello carries", async () => {
    const t = await harness.environment();
    const hello = (frame: Record<string, unknown>) => (frame["type"] === "hello" ? { ...frame, capabilities: ["self-update"] } : frame);
    const runtime = harness.runtime(inMemoryPlatform({ webSocket: rewritingWebSocket(hello, () => true) }));
    await runtime.start();

    await runtime.connections.add({ link: (await t.createPairing()).link });

    expect(only(runtime).descriptor.capabilities).toEqual(["self-update"]);
  });

  it("blocks with different-environment when hello names another environment, and keeps the old cache", async () => {
    const t = await harness.environment({ name: "desk" });
    let impostor = false;
    const hello = (frame: Record<string, unknown>) =>
      frame["type"] === "hello" ? { ...frame, environmentId: randomUUID(), environmentName: "impostor", scopes: ["read"] } : frame;
    const platform = inMemoryPlatform({ webSocket: rewritingWebSocket(hello, () => impostor) });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const cached = only(runtime);
    platform.clock.advance(60_000);

    impostor = true;
    await runtime.connections.retryNow(t.env.id);

    expect(only(runtime)).toEqual({ ...cached, phase: "blocked", blocked: "different-environment" });
    await until(() => t.env.sockets() === 0, "the blocked socket to close");

    impostor = false;
    await runtime.connections.retryNow(t.env.id);
    expect(only(runtime)).toMatchObject({ phase: "ready", blocked: null, descriptor: { lastSeen: platform.clock.now().toISOString() } });
  });

  it("compares the protocol on hello as well as on discovery, and says which side is behind", async () => {
    const t = await harness.environment();
    let newer = false;
    const hello = (frame: Record<string, unknown>) => (frame["type"] === "hello" ? { ...frame, protocolVersion: PROTOCOL_VERSION + 1 } : frame);
    const runtime = harness.runtime(inMemoryPlatform({ webSocket: rewritingWebSocket(hello, () => newer) }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    newer = true;
    await runtime.connections.retryNow(t.env.id);

    expect(only(runtime)).toMatchObject({ phase: "blocked", blocked: "unsupported-client" });
  });
});

describe("the in-process connections API", () => {
  it("reconnects on an address edit", async () => {
    const t = await harness.environment();
    const sockets = recordingWebSocket();
    const runtime = harness.runtime(inMemoryPlatform({ webSocket: sockets.factory }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    await runtime.connections.setAddress(t.env.id, `localhost:${t.address.port}`);

    expect(only(runtime)).toMatchObject({ address: `http://localhost:${t.address.port}`, phase: "ready" });
    expect(sockets.urls.at(-1)).toBe(`ws://localhost:${t.address.port}/ws`);
    await until(() => t.env.sockets() === 1, "the old socket to close");
  });

  it("blocks an address edit that reaches another environment, sends it no token, and keeps the old cache", async () => {
    const a = await harness.environment({ name: "desk" });
    const b = await harness.environment({ name: "laptop" });
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await a.createPairing()).link });
    const cached = only(runtime);

    await runtime.connections.setAddress(a.env.id, originOf(b.address));

    expect(only(runtime)).toEqual({ ...cached, address: originOf(b.address), phase: "blocked", blocked: "different-environment" });
    expect(b.env.sockets()).toBe(0);

    await runtime.connections.setAddress(a.env.id, originOf(a.address));
    expect(only(runtime)).toMatchObject({ phase: "ready", blocked: null });
  });

  it("disables: drops the socket and keeps the record and the token, across a restart; enabling connects again", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId } = only(runtime);

    await runtime.connections.setEnabled(t.env.id, false);

    expect(only(runtime)).toMatchObject({ enabled: false, phase: "disabled", clientSessionId });
    await until(() => t.env.sockets() === 0, "the socket to close");
    expect(await platform.secrets.get(t.env.id)).toEqual(expect.any(String));

    await runtime.close();
    const again = harness.runtime(inMemoryPlatform({ documents: platform.documents, secrets: platform.secrets }));
    await again.start();
    expect(only(again)).toMatchObject({ enabled: false, phase: "disabled", clientSessionId });
    expect(t.env.sockets()).toBe(0);

    await again.connections.setEnabled(t.env.id, true);
    expect(only(again)).toMatchObject({ enabled: true, phase: "ready", clientSessionId });
  });

  it("removes: revokes the client session while reachable, then forgets the token, the record and what hangs off it", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const { runtime, seams } = harness.withSeams(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId } = only(runtime);
    const forgotten: string[] = [];
    seams.onForget((environmentId) => void forgotten.push(environmentId));

    expect(await runtime.connections.remove(t.env.id)).toEqual({ revoked: true });

    expect(runtime.connections.list.read()).toEqual([]);
    expect(runtime.preferences.read()["environments.sequence"]).toEqual([]);
    expect(await platform.secrets.get(t.env.id)).toBeUndefined();
    expect(forgotten).toEqual([t.env.id]);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === clientSessionId)?.revokedAt).toEqual(expect.any(String));

    await runtime.close();
    const again = harness.runtime(inMemoryPlatform({ documents: platform.documents, secrets: platform.secrets }));
    await again.start();
    expect(again.connections.list.read()).toEqual([]);
  });

  it("removes an unreachable connection without the revoke", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    await t.close();
    await until(() => only(runtime).phase !== "ready", "the connection to drop");

    expect(await runtime.connections.remove(t.env.id)).toMatchObject({ revoked: false, reason: "unreachable", message: expect.any(String) });

    expect(runtime.connections.list.read()).toEqual([]);
    expect(await platform.secrets.get(t.env.id)).toBeUndefined();
  });

  it("removes a disabled connection: revokes over a one-off connection while the environment is reachable", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId } = only(runtime);
    await runtime.connections.setEnabled(t.env.id, false);
    await until(() => t.env.sockets() === 0, "the socket to close");

    expect(await runtime.connections.remove(t.env.id)).toEqual({ revoked: true });

    await until(() => t.env.sockets() === 0, "the one-off socket to close");
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === clientSessionId)?.revokedAt).toEqual(expect.any(String));
  });

  it("removes a connection without the admin scope, and says its client session is still live", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link });
    const { clientSessionId } = only(runtime);

    expect(await runtime.connections.remove(t.env.id)).toMatchObject({ revoked: false, reason: "scope", message: expect.stringContaining("admin") });

    expect(runtime.connections.list.read()).toEqual([]);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    expect(sessions.map((s) => s.id)).toContain(clientSessionId);
  });

  it("retries now: runs the connect again after a failure", async () => {
    const t = await harness.environment();
    let down = false;
    const runtime = harness.runtime(inMemoryPlatform({ fetch: failingFetch(() => down) }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    down = true;

    await runtime.connections.retryNow(t.env.id);
    expect(only(runtime).phase).toBe("backoff");

    down = false;
    await runtime.connections.retryNow(t.env.id);
    expect(only(runtime).phase).toBe("ready");
  });

  it("orders the environments: pairing order preset, then as set, kept across a restart; the first is the primary", async () => {
    const a = await harness.environment({ name: "a" });
    const b = await harness.environment({ name: "b" });
    const c = await harness.environment({ name: "c" });
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    for (const t of [a, b, c]) await runtime.connections.add({ link: (await t.createPairing()).link });
    const ids = (r: Runtime) => r.connections.list.read().map((record) => record.environmentId);
    expect(ids(runtime)).toEqual([a.env.id, b.env.id, c.env.id]);

    await runtime.connections.setOrder([c.env.id, a.env.id, b.env.id]);
    expect(ids(runtime)).toEqual([c.env.id, a.env.id, b.env.id]);
    await expect(runtime.connections.setOrder([a.env.id, b.env.id])).rejects.toThrow(/every saved environment/);
    await expect(runtime.connections.setOrder([a.env.id, b.env.id, randomUUID()])).rejects.toThrow(/every saved environment/);

    await runtime.close();
    const again = harness.runtime(inMemoryPlatform({ documents: platform.documents, secrets: platform.secrets }));
    await again.start();
    expect(ids(again)).toEqual([c.env.id, a.env.id, b.env.id]);
    expect(again.preferences.read()["environments.sequence"]).toEqual([c.env.id, a.env.id, b.env.id]);
  });

  it("keeps the last environment used", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    await runtime.connections.setLastUsed(t.env.id);
    await runtime.close();

    const again = harness.runtime(inMemoryPlatform({ documents: platform.documents, secrets: platform.secrets }));
    await again.start();
    expect(again.preferences.read()["environments.lastUsed"]).toBe(t.env.id);
  });

  it("refuses an environment it has no connection to", async () => {
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    const id = randomUUID();
    await expect(runtime.connections.setEnabled(id, false)).rejects.toThrow(/no saved connection/i);
    await expect(runtime.connections.remove(id)).rejects.toThrow(/no saved connection/i);
    await expect(runtime.connections.retryNow(id)).rejects.toThrow(/no saved connection/i);
  });
});
