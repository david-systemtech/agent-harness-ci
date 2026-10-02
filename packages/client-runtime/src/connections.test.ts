import { randomUUID } from "node:crypto";
import { Ceiling, PROTOCOL_VERSION, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { presetColour } from "../../environment/src/look/look.js";
import { HARNESS_VERSION } from "../../environment/src/serve/start.js";
import { failingFetch, originOf, recordingWebSocket, rewritingWebSocket, until, useHarness } from "../test/harness.js";
import { PAIRED_CONNECTIONS_DOCUMENT } from "./connections/records.js";
import { REVOKE_TIMEOUT_MS } from "./connections/registry.js";
import type { HttpFetch, WebSocketFactory } from "./platform.js";
import type { Runtime } from "./runtime.js";
import { globalFetch, globalWebSocket, inMemoryDocuments, inMemoryPlatform, manualClock, type InMemoryDocumentStore } from "./testing/in-memory-platform.js";

const harness = useHarness();

const DAY = 24 * 60 * 60 * 1000;

const only = (runtime: Runtime) => {
  const [record, ...rest] = runtime.connections.list.read();
  if (!record || rest.length > 0) throw new Error(`Expected one connection, found ${runtime.connections.list.read().length}.`);
  return record;
};

describe("hello", () => {
  it("fills the scopes, ceiling, flags, name, icon and colour, and the discovery document the harness version", async () => {
    const t = await harness.environment({ name: "desk", platform: "linux" });
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
        // The environment's own (#323): until set, the platform's icon and a colour by its id's hash.
        icon: "server",
        colour: presetColour(t.env.id),
        harnessVersion: HARNESS_VERSION,
        protocolVersion: 1,
        capabilities: ["forge", "keyManagers", "managedTools", "fileUndo", "banks", "setup"],
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

    // A block is a failure after ready: the environment is unreachable from then.
    expect(only(runtime)).toEqual({ ...cached, phase: "blocked", blocked: "different-environment", unreachableSince: platform.clock.now().toISOString() });
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

describe("token refresh", () => {
  it("refreshes on connect through access.sessions.refresh when fewer than seven days remain, and keeps the new token", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId, expiresAt } = only(runtime);
    expect(Date.parse(expiresAt ?? "") - platform.clock.now().getTime()).toBe(30 * DAY);
    const before = await platform.secrets.get(t.env.id);
    await runtime.close();

    // 24 days on, with no socket open: six days are left.
    t.clock.advance(24 * DAY);
    const later = inMemoryPlatform({ clock: manualClock(t.clock.now()), documents: platform.documents, secrets: platform.secrets });
    const again = harness.runtime(later);
    await again.start();
    // The refresh is not waited on by start: it is under way once the connection is ready.
    await until(() => only(again).expiresAt !== expiresAt, "the refresh to land");

    const renewed = only(again);
    expect(renewed).toMatchObject({ phase: "ready", clientSessionId, refreshFailed: null });
    expect(Date.parse(renewed.expiresAt ?? "") - t.clock.now().getTime()).toBe(30 * DAY);
    const token = await platform.secrets.get(t.env.id);
    expect(token).not.toBe(before);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === clientSessionId)?.expiresAt).toBe(renewed.expiresAt);

    // The new token is the one the next connect sends.
    await again.close();
    const third = harness.runtime(inMemoryPlatform({ clock: manualClock(t.clock.now()), documents: platform.documents, secrets: platform.secrets }));
    await third.start();
    expect(only(third).phase).toBe("ready");
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
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await a.createPairing()).link });
    const cached = only(runtime);

    await runtime.connections.setAddress(a.env.id, originOf(b.address));

    expect(only(runtime)).toEqual({
      ...cached,
      address: originOf(b.address),
      phase: "blocked",
      blocked: "different-environment",
      unreachableSince: platform.clock.now().toISOString(),
    });
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

  it("opens no one-off revoke socket when discovery answers after the revoke timed out", async () => {
    const t = await harness.environment();
    let hold = false;
    let release: () => void = () => undefined;
    let held = false;
    let settled = false;
    const fetch: HttpFetch = async (url, request) => {
      if (hold) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      const response = await globalFetch()(url, request);
      if (hold) settled = true;
      return response;
    };
    const sockets = recordingWebSocket();
    const platform = inMemoryPlatform({ fetch, webSocket: sockets.factory });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    await runtime.connections.setEnabled(t.env.id, false);
    await until(() => t.env.sockets() === 0, "the socket to close");
    const opened = sockets.urls.length;

    hold = true;
    const removing = runtime.connections.remove(t.env.id);
    await until(() => held, "the one-off revoke to read discovery");
    platform.clock.advance(REVOKE_TIMEOUT_MS);
    expect(await removing).toMatchObject({ revoked: false, reason: "unreachable" });

    release();
    await until(() => settled, "the held discovery to answer");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sockets.urls.length).toBe(opened);
    expect(t.env.sockets()).toBe(0);
  });

  it("closes a one-off revoke socket whose hello arrives after the revoke timed out, and sends no revoke on it", async () => {
    const t = await harness.environment();
    let hold = false;
    const held: (() => void)[] = [];
    const webSocket: WebSocketFactory = (url, handlers) =>
      globalWebSocket()(url, { ...handlers, onMessage: (text) => (hold ? held.push(() => handlers.onMessage(text)) : handlers.onMessage(text)) });
    const platform = inMemoryPlatform({ webSocket });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId } = only(runtime);
    await runtime.connections.setEnabled(t.env.id, false);
    await until(() => t.env.sockets() === 0, "the socket to close");

    hold = true;
    const removing = runtime.connections.remove(t.env.id);
    await until(() => held.length > 0, "the one-off socket's hello to be held");
    platform.clock.advance(REVOKE_TIMEOUT_MS);
    expect(await removing).toMatchObject({ revoked: false, reason: "unreachable" });

    hold = false;
    for (const deliver of held.splice(0)) deliver();
    await until(() => t.env.sockets() === 0, "the late one-off socket to close");
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === clientSessionId)?.revokedAt).toBeNull();
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

  it("shows the blocked reason only with blocked: a retry that finds nothing stays blocked, disabling hides the reason and keeps it to re-check", async () => {
    const t = await harness.environment();
    let down = false;
    const platform = inMemoryPlatform({ fetch: failingFetch(() => down) });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const admin = await t.client();
    await admin.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: String(only(runtime).clientSessionId) });
    await until(() => only(runtime).phase === "blocked", "the revoke to block the connection");
    expect(only(runtime).blocked).toBe("revoked");
    const savedBlocked = () => (platform.documents.entries()[PAIRED_CONNECTIONS_DOCUMENT] as Record<string, { blocked: unknown }>)[t.env.id]?.blocked;

    // A re-check that cannot read discovery leaves the block as it was (#126), with no retry.
    down = true;
    await runtime.connections.retryNow(t.env.id);
    expect(only(runtime)).toMatchObject({ phase: "blocked", blocked: "revoked", retryAt: null });

    down = false;
    await runtime.connections.retryNow(t.env.id);
    expect(only(runtime)).toMatchObject({ phase: "blocked", blocked: "revoked" });
    await runtime.connections.setEnabled(t.env.id, false);
    expect(only(runtime)).toMatchObject({ phase: "disabled", blocked: null });
    expect(savedBlocked()).toBe("revoked");

    // Enabled again, the block is re-checked quietly: one notice in all.
    await runtime.connections.setEnabled(t.env.id, true);
    expect(only(runtime)).toMatchObject({ phase: "blocked", blocked: "revoked" });
    expect(runtime.projections.notices.read().map((n) => n.kind)).toEqual(["revoked"]);
  });

  /** A paired connection blocked as `revoked` on a platform whose network `down()` controls. */
  const blockedByRevoke = async (options: { documents?: InMemoryDocumentStore; down: () => boolean }) => {
    const t = await harness.environment();
    const platform = inMemoryPlatform({ fetch: failingFetch(options.down), ...(options.documents && { documents: options.documents }) });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const admin = await t.client();
    await admin.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: String(only(runtime).clientSessionId) });
    await until(() => only(runtime).phase === "blocked", "the revoke to block the connection");
    const savedBlocked = () => (platform.documents.entries()[PAIRED_CONNECTIONS_DOCUMENT] as Record<string, { blocked: unknown }>)[t.env.id]?.blocked;
    return { t, platform, runtime, savedBlocked };
  };

  it("reports a background write that fails, never leaving it to reject unobserved", async () => {
    const base = inMemoryDocuments();
    let failNext = false;
    const documents: InMemoryDocumentStore = {
      ...base,
      set: async (key, value) => {
        if (failNext && key === PAIRED_CONNECTIONS_DOCUMENT) {
          failNext = false;
          throw new Error("the disk is full");
        }
        return base.set(key, value);
      },
    };
    const { t, platform, runtime } = await blockedByRevoke({ documents, down: () => false });

    // The re-check's discovery document is written to the record in the background.
    failNext = true;
    await runtime.connections.retryNow(t.env.id);

    expect(only(runtime)).toMatchObject({ phase: "blocked", blocked: "revoked" });
    await until(() => platform.reported.length > 0, "the failed write to be reported");
    expect(platform.reported).toEqual([expect.objectContaining({ message: "the disk is full" })]);
  });

  it("a renderer whose connections.list listener throws stops neither the attempt nor its persistence, and is reported", async () => {
    const { t, platform, runtime, savedBlocked } = await blockedByRevoke({ down: () => false });
    const fault = new Error("the renderer failed");
    runtime.connections.list.subscribe(() => {
      throw fault;
    });

    const reads = platform.documents.entries()[PAIRED_CONNECTIONS_DOCUMENT];
    await runtime.connections.retryNow(t.env.id);

    // The attempt ran to its end (discovery, then no token to send) and its write landed.
    expect(only(runtime)).toMatchObject({ phase: "blocked", blocked: "revoked" });
    expect(savedBlocked()).toBe("revoked");
    expect(platform.documents.entries()[PAIRED_CONNECTIONS_DOCUMENT]).toEqual(reads);
    expect(platform.reported).toContain(fault);
  });

  it("a save that fails during start is reported, and leaves one socket, never an orphan still feeding frames", async () => {
    const t = await harness.environment();
    const saved = inMemoryPlatform();
    const pairing = harness.runtime(saved);
    await pairing.start();
    await pairing.connections.add({ link: (await t.createPairing()).link });
    await pairing.close();
    await until(() => t.env.sockets() === 0, "the pairing runtime's socket to close");
    let failNext = true;
    const documents: InMemoryDocumentStore = {
      ...saved.documents,
      set: async (key, value) => {
        if (failNext && key === PAIRED_CONNECTIONS_DOCUMENT) {
          failNext = false;
          throw new Error("the disk is full");
        }
        return saved.documents.set(key, value);
      },
    };
    const platform = inMemoryPlatform({ documents, secrets: saved.secrets });
    const runtime = harness.runtime(platform);

    // The record's writes are the connection's background work (#126): a failed one is reported, and the start goes on.
    await runtime.start();
    await until(() => platform.reported.length > 0, "the failed save to be reported");
    expect(platform.reported).toEqual([expect.objectContaining({ message: "the disk is full" })]);

    expect(only(runtime).phase).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.env.sockets()).toBe(1);
  });

  it("an add before start keeps the connections and sequence already saved", async () => {
    const a = await harness.environment();
    const b = await harness.environment();
    const saved = inMemoryPlatform();
    const first = harness.runtime(saved);
    await first.start();
    await first.connections.add({ link: (await a.createPairing()).link });
    await first.close();

    const runtime = harness.runtime(inMemoryPlatform({ documents: saved.documents, secrets: saved.secrets }));
    expect(await runtime.connections.add({ link: (await b.createPairing()).link })).toMatchObject({ status: "paired" });

    const documents = saved.documents.entries();
    expect(Object.keys(documents[PAIRED_CONNECTIONS_DOCUMENT] as object).sort()).toEqual([a.env.id, b.env.id].sort());
    expect(documents["environments.sequence"]).toEqual([a.env.id, b.env.id]);
    await runtime.start();
    expect(runtime.connections.list.read().map((r) => [r.environmentId, r.phase])).toEqual([
      [a.env.id, "ready"],
      [b.env.id, "ready"],
    ]);
  });

  it("a retry while a pairing is being kept opens no second socket, and the pairing's is the one attached", async () => {
    const t = await harness.environment();
    const base = inMemoryDocuments();
    let hold = false;
    let held = false;
    let release: () => void = () => undefined;
    const documents: InMemoryDocumentStore = {
      ...base,
      set: async (key, value) => {
        if (hold && key === PAIRED_CONNECTIONS_DOCUMENT) {
          hold = false;
          held = true;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return base.set(key, value);
      },
    };
    const runtime = harness.runtime(inMemoryPlatform({ documents }));
    await runtime.start();

    // A first pairing: the new entry's machine starts only when the pairing's socket is adopted, so a retry meanwhile opens nothing.
    hold = true;
    const adding = runtime.connections.add({ link: (await t.createPairing()).link });
    await until(() => held, "the new record's save to be held");
    const ignored = runtime.connections.retryNow(t.env.id);
    release();
    expect(await adding).toMatchObject({ status: "paired" });
    await ignored;
    expect(only(runtime).phase).toBe("ready");
    await until(() => t.env.sockets() === 1, "one socket");

    // A re-pair in place of a running connection: its machine holds from giving up the old socket to adopting the new one (#126),
    // so a retry meanwhile opens nothing.
    held = false;
    hold = true;
    const rePairing = runtime.connections.add({ link: (await t.createPairing()).link }, { rePair: t.env.id });
    await until(() => held, "the re-paired record's save to be held");
    await until(() => t.env.sockets() === 1, "the old socket to close");
    const retrying = runtime.connections.retryNow(t.env.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.env.sockets()).toBe(1);
    release();
    expect(await rePairing).toMatchObject({ status: "paired" });
    await retrying;

    expect(only(runtime).phase).toBe("ready");
    await until(() => t.env.sockets() === 1, "the retry's socket to close");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.env.sockets()).toBe(1);
  });

  it("reports a seam's frame or close listener that throws, leaving nothing unhandled", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const { runtime, seams } = harness.withSeams(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const onFrame = new Error("the frame listener failed");
    const onClose = new Error("the close listener failed");
    seams.onFrame(() => {
      throw onFrame;
    });
    seams.onClose(() => {
      throw onClose;
    });

    await seams.request(t.env.id, "access.sessions.list", {});
    await until(() => platform.reported.includes(onFrame), "the frame listener's fault to be reported");
    const admin = await t.client();
    await admin.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: String(only(runtime).clientSessionId) });
    await until(() => platform.reported.includes(onClose), "the close listener's fault to be reported");
    expect(only(runtime).phase).toBe("blocked");
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
