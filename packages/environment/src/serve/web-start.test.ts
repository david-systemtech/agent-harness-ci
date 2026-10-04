import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { pairingPreset, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { startTestEnvironment } from "../../test/helper.js";
import { useCleanups } from "../../test/cleanups.js";
const { onCleanup } = useCleanups();

describe("configured web links and wire boundaries", () => {
  it("mints both Phone and My own client with the canonical HTTPS port, preserving each grant", async () => {
    const t = await startTestEnvironment({ webOrigin: "https://web.example:8443" }); onCleanup(() => t.close());
    for (const id of ["phone", "own-client"] as const) {
      const preset = pairingPreset(id);
      const pairing = await t.createPairing({ scopes: preset.scopes, ceiling: preset.ceiling });
      expect(pairing.link).toBe(`https://web.example:8443/pair#${pairing.code}`);
      const exchange = await t.pairExchange({ code: pairing.code, kind: "web", label: "Phone", protocolVersion: PROTOCOL_VERSION });
      expect(exchange.status).toBe(200);
      expect(exchange.body).toMatchObject({ scopes: preset.scopes, ceiling: preset.ceiling });
    }
    const admin = await t.client();
    const pairing = await admin.apply("access.pairings.create", { commandId: randomUUID(), scopes: ["read"], ceiling: "plan" });
    expect(pairing.link).toMatch(/^https:\/\/web.example:8443\/pair#/);
    const rejected = await fetch(`http://127.0.0.1:${t.address.port}/api/pair`, { method: "POST", headers: { Origin: "https://evil.example", "x-forwarded-host": "web.example:8443" } });
    expect(rejected.status).toBe(403);
  });
  it("rejects an arbitrary browser WebSocket Origin before authentication, preserving desktop and CLI connections", async () => {
    const t = await startTestEnvironment(); onCleanup(() => t.close());
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.address.port}/ws`, { origin: "https://evil.example" });
      ws.on("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode ?? 0); });
      ws.on("error", () => undefined);
    });
    expect(status).toBe(403);
    expect((await t.client()).hello.type).toBe("hello");
  });
  it.each(["http://web.example", "https://web.example/", "https://user:password@web.example", "https://web.example/path", "https://web.example#code"])("refuses noncanonical web origin %s", async webOrigin => {
    await expect(startTestEnvironment({ webOrigin })).rejects.toThrow();
  });
});
