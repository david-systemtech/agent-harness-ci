import { randomUUID } from "node:crypto";
import { DEFAULT_ENVIRONMENT_PORT, DISCOVERY_PATH, PAIRING_TTL_MS, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { Address } from "../../environment/src/serve/http.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { originOf, rewritingFetch, rewritingWebSocket, until, useHarness } from "../test/harness.js";
import { parsePairingInput } from "./pairing.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

describe("reading what David pastes or types", () => {
  it("reads a link, the code in its fragment", () => {
    expect(parsePairingInput({ link: " http://100.64.0.7:7433/pair#K7Q2M-XH4RT " })).toEqual({
      ok: true,
      origin: "http://100.64.0.7:7433",
      code: "K7Q2MXH4RT",
    });
  });

  it("reads an address and a typed code, in any case, with spaces or hyphens", () => {
    expect(parsePairingInput({ address: "desk.tail1234.ts.net:7433", code: "k7q2m xh4rt" })).toEqual({
      ok: true,
      origin: "http://desk.tail1234.ts.net:7433",
      code: "K7Q2MXH4RT",
    });
    expect(parsePairingInput({ address: "http://[fd7a::1]:8000/", code: "K7Q2M-XH4RT" })).toMatchObject({
      ok: true,
      origin: "http://[fd7a::1]:8000",
    });
  });

  it("takes an address without a port at the environment's default port", async () => {
    const { DEFAULT_PORT } = await import("../../environment/src/serve/start.js");
    expect(DEFAULT_ENVIRONMENT_PORT).toBe(DEFAULT_PORT);
    expect(parsePairingInput({ address: "desk", code: "K7Q2MXH4RT" })).toMatchObject({ ok: true, origin: "http://desk:7433" });
  });

  it("refuses a link that carries no code, an address that is not one, and a code that is not one", () => {
    expect(parsePairingInput({ link: "http://desk:7433/pair" })).toMatchObject({ ok: false, failure: { reason: "invalid-link" } });
    expect(parsePairingInput({ address: "desk:7433", code: "0000" })).toMatchObject({ ok: false, failure: { reason: "invalid-code" } });
    expect(parsePairingInput({ address: "desk:7433/some/path?x", code: "K7Q2MXH4RT" })).toMatchObject({
      ok: false,
      failure: { reason: "invalid-address" },
    });
  });
});

describe("pairing with an environment", () => {
  it("pairs from a link: reads discovery, exchanges the code with kind and label, keeps the token, writes the record, connects", async () => {
    const t = await harness.environment({ name: "desk" });
    const platform = inMemoryPlatform({ kind: "tui", label: "Seth's laptop" });
    const runtime = harness.runtime(platform);
    await runtime.start();
    const { link } = await t.createPairing();

    expect(await runtime.connections.add({ link })).toEqual({ status: "paired", environmentId: t.env.id });

    const [record] = runtime.connections.list.read();
    expect(record).toMatchObject({
      environmentId: t.env.id,
      kind: "paired",
      address: originOf(t.address),
      enabled: true,
      phase: "ready",
      blocked: null,
    });
    const token = await platform.secrets.get(t.env.id);
    expect(token).toEqual(expect.any(String));
    // The token lives in secret storage only.
    expect(JSON.stringify(platform.documents.entries())).not.toContain(token);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    expect(sessions.find((s) => s.id === record?.clientSessionId)).toMatchObject({ kind: "tui", label: "Seth's laptop", local: false });
  });

  it("pairs from an address and the short code", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    const { code } = await t.createPairing();

    const outcome = await runtime.connections.add({ address: `${t.address.host}:${t.address.port}`, code: code.toLowerCase() });

    expect(outcome).toEqual({ status: "paired", environmentId: t.env.id });
    expect(runtime.connections.list.read()[0]?.phase).toBe("ready");
  });

  it("keeps a paired connection across a restart and connects it again", async () => {
    const t = await harness.environment();
    const first = inMemoryPlatform();
    const runtime = harness.runtime(first);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId } = runtime.connections.list.read()[0] ?? {};
    await runtime.close();

    const again = harness.runtime(inMemoryPlatform({ documents: first.documents, secrets: first.secrets }));
    await again.start();

    expect(again.connections.list.read()).toEqual([
      expect.objectContaining({ environmentId: t.env.id, kind: "paired", clientSessionId, phase: "ready" }),
    ]);
  });

  it("offers to re-pair a saved environment in place without spending the code, and re-pairs when asked", async () => {
    const t = await harness.environment({ name: "desk" });
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const before = runtime.connections.list.read()[0];
    const { link } = await t.createPairing();

    expect(await runtime.connections.add({ link })).toEqual({ status: "re-pair-offered", environmentId: t.env.id, name: "desk" });

    expect(await runtime.connections.add({ link }, { rePair: t.env.id })).toEqual({ status: "paired", environmentId: t.env.id });
    const after = runtime.connections.list.read();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ environmentId: t.env.id, phase: "ready" });
    expect(after[0]?.clientSessionId).not.toBe(before?.clientSessionId);
  });

  describe("fails with a typed reason", () => {
    it("expired-code: the code's ten minutes are over", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();
      const { link } = await t.createPairing();
      t.clock.advance(PAIRING_TTL_MS + 1);

      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: { reason: "expired-code", message: expect.any(String) },
      });
      expect(runtime.connections.list.read()).toEqual([]);
    });

    it("used-code: the code has been exchanged already", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();
      const { code, link } = await t.createPairing();
      expect((await t.pairExchange({ code, kind: "program", label: "first", protocolVersion: PROTOCOL_VERSION })).status).toBe(200);

      expect(await runtime.connections.add({ link })).toMatchObject({ status: "failed", failure: { reason: "used-code" } });
    });

    it("unreachable: nothing answers at the address", async () => {
      const t = await harness.environment();
      const { link } = await t.createPairing();
      await t.close();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();

      expect(await runtime.connections.add({ link })).toMatchObject({ status: "failed", failure: { reason: "unreachable" } });
    });

    it("protocol-mismatch: the environment speaks an older protocol than this client, and the code is not spent", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform(), { protocolVersion: PROTOCOL_VERSION + 1 });
      await runtime.start();
      const { code, link } = await t.createPairing();

      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: { reason: "protocol-mismatch", message: expect.stringContaining("update the environment") },
      });
      expect((await t.pairExchange({ code, kind: "program", label: "later", protocolVersion: PROTOCOL_VERSION })).status).toBe(200);
    });

    it("unsupported-client: the environment speaks a newer protocol than this client", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(
        inMemoryPlatform({ fetch: rewritingFetch(DISCOVERY_PATH, (body) => ({ ...body, protocolVersion: PROTOCOL_VERSION + 1 })) }),
      );
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: { reason: "unsupported-client", message: expect.stringContaining("update this client") },
      });
    });

    it("not-ready: discovery says the environment is still starting", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let address: Address | undefined;
      const starting = startTestEnvironment({
        hooks: {
          beforeStep: async (step, progress) => {
            if (step !== "prepared") return;
            address = progress.address;
            await gate;
          },
        },
      });
      harness.onCleanup(async () => {
        release();
        await (await starting).close();
      });
      await until(() => address !== undefined, "the environment to bind");
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();

      expect(await runtime.connections.add({ address: originOf(address as Address), code: "23456-789AB" })).toMatchObject({
        status: "failed",
        failure: { reason: "not-ready" },
      });
    });

    it("different-environment: re-pairing a saved connection with another environment's code", async () => {
      const a = await harness.environment({ name: "desk" });
      const b = await harness.environment({ name: "laptop" });
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();
      await runtime.connections.add({ link: (await a.createPairing()).link });

      expect(await runtime.connections.add({ link: (await b.createPairing()).link }, { rePair: a.env.id })).toMatchObject({
        status: "failed",
        failure: { reason: "different-environment" },
      });
      expect(runtime.connections.list.read().map((r) => r.environmentId)).toEqual([a.env.id]);
    });

    it("invalid-code: the environment issued no such code", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();

      expect(await runtime.connections.add({ address: originOf(t.address), code: "23456-789AB" })).toMatchObject({
        status: "failed",
        failure: { reason: "invalid-code" },
      });
    });

    it("different-environment: hello names another environment than discovery did; the client session is revoked and nothing is kept", async () => {
      const t = await harness.environment();
      const elsewhere = randomUUID();
      const platform = inMemoryPlatform({ fetch: rewritingFetch(DISCOVERY_PATH, (body) => ({ ...body, environmentId: elsewhere })) });
      const runtime = harness.runtime(platform);
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: { reason: "different-environment" },
      });

      expect(runtime.connections.list.read()).toEqual([]);
      expect(await platform.secrets.get(elsewhere)).toBeUndefined();
      expect(await platform.secrets.get(t.env.id)).toBeUndefined();
      const admin = await t.client();
      const { sessions } = await admin.apply("access.sessions.list", {});
      expect(sessions.filter((s) => s.kind === "tui" && !s.local).map((s) => s.revokedAt)).toEqual([expect.any(String)]);
    });

    it("unsupported-client: hello speaks a newer protocol than discovery said, and nothing is kept", async () => {
      const t = await harness.environment();
      const newer = (frame: Record<string, unknown>) => (frame["type"] === "hello" ? { ...frame, protocolVersion: PROTOCOL_VERSION + 1 } : frame);
      const platform = inMemoryPlatform({ webSocket: rewritingWebSocket(newer, () => true) });
      const runtime = harness.runtime(platform);
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: { reason: "unsupported-client" },
      });
      expect(runtime.connections.list.read()).toEqual([]);
      expect(await platform.secrets.get(t.env.id)).toBeUndefined();
    });
  });
});
