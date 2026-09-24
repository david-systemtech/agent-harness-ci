import { SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { TOP_CEILING } from "../../environment/src/auth/client-sessions.js";
import { grantReader, originOf, until, useHarness } from "../test/harness.js";
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

  it("re-derives the local connection on every start and never saves it", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform({ kind: "tui", grant: grantReader(t) });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.close();

    const withoutGrant = harness.runtime(inMemoryPlatform({ documents: platform.documents, secrets: platform.secrets }));
    await withoutGrant.start();
    expect(withoutGrant.connections.list.read()).toEqual([]);
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
    await until(() => first.connections.list.read()[0]?.phase === "disconnected", "the first desktop's socket to close");
    expect(first.connections.list.read()[0]?.bye).toBe("revoked");
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

  it("has no local connection when there is no grant to read", async () => {
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: { read: async () => undefined } }));
    await runtime.start();
    expect(runtime.local.read()).toEqual({ state: "no-grant" });
    expect(runtime.connections.list.read()).toEqual([]);
  });

  it("reports an environment that does not answer at the grant's address", async () => {
    const t = await harness.environment();
    const grant = t.grant();
    await t.close();
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: { read: async () => grant } }));
    await runtime.start();
    expect(runtime.local.read()).toMatchObject({ state: "failed", reason: "unreachable", message: expect.any(String) });
  });

  it("reads no grant for a browser tab", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform({ kind: "web", grant: grantReader(t) }));
    await runtime.start();
    expect(runtime.local.read()).toEqual({ state: "none" });
    expect(runtime.connections.list.read()).toEqual([]);
  });
});
