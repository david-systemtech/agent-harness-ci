import { DISCOVERY_PATH, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { TOP_CEILING } from "../../environment/src/auth/client-sessions.js";
import { grantReader, notJsonAt, originOf, until, useHarness } from "../test/harness.js";
import { PAIRED_CONNECTIONS_DOCUMENT } from "./connections/records.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

describe("the bootstrap grant", () => {
  it("exchanges the grant's secret over loopback for a local client session with every scope and the top ceiling", async () => {
    const t = await harness.environment({ name: "desk" });
    const runtime = harness.runtime(inMemoryPlatform({ kind: "desktop", label: "the desktop", grant: grantReader(t) }));

    await runtime.start();

    expect(runtime.local.read()).toEqual({ state: "exchanged", environmentId: t.env.id });
    expect(runtime.connections.list.read()).toEqual([
      expect.objectContaining({
        environmentId: t.env.id,
        kind: "local",
        address: originOf(t.address),
        enabled: true,
        phase: "ready",
        scopes: [...SCOPES],
        ceiling: TOP_CEILING,
        descriptor: expect.objectContaining({ name: "desk" }),
      }),
    ]);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    const id = runtime.connections.list.read()[0]?.clientSessionId;
    expect(sessions.find((s) => s.id === id)).toMatchObject({ kind: "desktop", label: "the desktop", local: true });
  });

  it("re-derives the local connection on every start and never saves its token or client session", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform({ kind: "tui", grant: grantReader(t) });
    const runtime = harness.runtime(platform);
    await runtime.start();
    const { clientSessionId } = runtime.connections.list.read()[0] ?? {};
    await runtime.close();

    expect(await platform.secrets.get(t.env.id)).toBeUndefined();
    expect(JSON.stringify(platform.documents.entries())).not.toContain(String(clientSessionId));
    const noReader = harness.runtime(inMemoryPlatform({ documents: platform.documents, secrets: platform.secrets }));
    await noReader.start();
    expect(noReader.connections.list.read()).toEqual([]);
  });

  it("replaces a paired connection to the local environment, revoking it; with the service down it stays listed as service-down", async () => {
    const t = await harness.environment({ name: "desk" });
    const platform = inMemoryPlatform({ kind: "tui" });
    const pairedFirst = harness.runtime(platform);
    await pairedFirst.start();
    await pairedFirst.connections.add({ link: (await t.createPairing()).link });
    const paired = pairedFirst.connections.list.read()[0]?.clientSessionId;
    await pairedFirst.close();

    const stores = { documents: platform.documents, secrets: platform.secrets };
    const withGrant = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t), ...stores }));
    await withGrant.start();
    expect(withGrant.connections.list.read()).toEqual([expect.objectContaining({ environmentId: t.env.id, kind: "local", phase: "ready" })]);
    expect(await platform.secrets.get(t.env.id)).toBeUndefined();
    // The paired entry is gone from the paired document, and the local one never enters it.
    expect(await platform.documents.get(PAIRED_CONNECTIONS_DOCUMENT)).toEqual({});
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === paired)?.revokedAt).toEqual(expect.any(String));
    await withGrant.close();

    const serviceDown = harness.runtime(inMemoryPlatform({ kind: "tui", grant: { read: async () => undefined }, ...stores }));
    await serviceDown.start();
    expect(serviceDown.local.read()).toMatchObject({ state: "failed", reason: "service-down" });
    expect(serviceDown.connections.list.read()).toEqual([
      expect.objectContaining({ environmentId: t.env.id, kind: "local", phase: "service-down", descriptor: expect.objectContaining({ name: "desk" }) }),
    ]);

    // The grant is back: retrying exchanges it and connects.
    const back = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t), ...stores }));
    await back.start();
    expect(back.connections.list.read()[0]).toMatchObject({ kind: "local", phase: "ready" });
  });

  it("retries a local environment whose service was down: the grant is exchanged again", async () => {
    const t = await harness.environment();
    let up = true;
    const platform = inMemoryPlatform({ kind: "tui", grant: { read: async () => (up ? t.grant() : undefined) } });
    const first = harness.runtime(platform);
    await first.start();
    await first.close();
    up = false;
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: { read: async () => (up ? t.grant() : undefined) }, documents: platform.documents, secrets: platform.secrets }));
    await runtime.start();
    expect(runtime.connections.list.read()[0]?.phase).toBe("service-down");

    up = true;
    await runtime.connections.retryNow(t.env.id);

    expect(runtime.connections.list.read()[0]?.phase).toBe("ready");
    expect(runtime.local.read()).toEqual({ state: "exchanged", environmentId: t.env.id });
  });

  it("a local environment whose discovery answers something that is not JSON is refused and waits for a retry, not service-down", async () => {
    const t = await harness.environment();
    let proxied = true;
    const fetch = notJsonAt(DISCOVERY_PATH, 502, () => proxied);
    const refused = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t), fetch }));
    await refused.start();
    expect(refused.local.read()).toMatchObject({ state: "failed", reason: "refused", message: expect.stringContaining("502") });

    proxied = false;
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t), fetch }));
    await runtime.start();
    expect(runtime.connections.list.read()[0]?.phase).toBe("ready");
    proxied = true;
    await runtime.connections.retryNow(t.env.id);
    expect(runtime.connections.list.read()[0]?.phase).toBe("backoff");
  });

  it("keeps an absent local environment's place in the sequence when the others are reordered", async () => {
    const t = await harness.environment({ name: "local" });
    const a = await harness.environment({ name: "a" });
    const b = await harness.environment({ name: "b" });
    const platform = inMemoryPlatform({ kind: "tui", grant: grantReader(t) });
    const first = harness.runtime(platform);
    await first.start();
    for (const other of [a, b]) await first.connections.add({ link: (await other.createPairing()).link });
    await first.connections.setOrder([a.env.id, t.env.id, b.env.id]);
    await first.close();

    const noReader = harness.runtime(inMemoryPlatform({ kind: "tui", documents: platform.documents, secrets: platform.secrets }));
    await noReader.start();
    await noReader.connections.setOrder([b.env.id, a.env.id]);

    expect(noReader.preferences.read()["environments.sequence"]).toEqual([b.env.id, t.env.id, a.env.id]);
  });

  it("replaces the previous desktop client session on a second desktop start", async () => {
    const t = await harness.environment();
    const first = harness.runtime(inMemoryPlatform({ kind: "desktop", grant: grantReader(t) }));
    await first.start();
    const replaced = first.connections.list.read()[0]?.clientSessionId;

    const second = harness.runtime(inMemoryPlatform({ kind: "desktop", grant: grantReader(t) }));
    await second.start();
    const current = second.connections.list.read()[0]?.clientSessionId;

    expect(current).not.toBe(replaced);
    await until(() => first.connections.list.read()[0]?.phase === "blocked", "the first desktop's socket to close");
    expect(first.connections.list.read()[0]).toMatchObject({ bye: "revoked", blocked: "revoked" });
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    expect(sessions.filter((s) => s.local && s.kind === "desktop").map((s) => s.id)).toEqual([current]);
  });

  it("does not replace one terminal UI's client session with another's", async () => {
    const t = await harness.environment();
    const first = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t) }));
    const second = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t) }));
    await first.start();
    await second.start();

    expect(first.connections.list.read()[0]?.phase).toBe("ready");
    expect(second.connections.list.read()[0]?.phase).toBe("ready");
  });

  it("puts the local environment first, ahead of environments paired before it was known", async () => {
    const t = await harness.environment({ name: "local" });
    const other = await harness.environment({ name: "other" });
    const platform = inMemoryPlatform({ kind: "tui" });
    const before = harness.runtime(platform);
    await before.start();
    await before.connections.add({ link: (await other.createPairing()).link });
    await before.close();

    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t), documents: platform.documents, secrets: platform.secrets }));
    await runtime.start();

    expect(runtime.connections.list.read().map((r) => [r.environmentId, r.kind])).toEqual([
      [t.env.id, "local"],
      [other.env.id, "paired"],
    ]);
  });

  it("has no local connection when there is no grant to read and none was seen before", async () => {
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: { read: async () => undefined } }));
    await runtime.start();
    expect(runtime.local.read()).toMatchObject({ state: "failed", reason: "service-down" });
    expect(runtime.connections.list.read()).toEqual([]);
  });

  it("reports an environment that does not answer at the grant's address", async () => {
    const t = await harness.environment();
    const grant = t.grant();
    await t.close();
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: { read: async () => grant } }));
    await runtime.start();
    expect(runtime.local.read()).toMatchObject({ state: "failed", reason: "service-down", message: expect.any(String) });
  });

  it("reads no grant for a browser tab", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform({ kind: "web", grant: grantReader(t) }));
    await runtime.start();
    expect(runtime.local.read()).toEqual({ state: "none" });
    expect(runtime.connections.list.read()).toEqual([]);
  });
});
