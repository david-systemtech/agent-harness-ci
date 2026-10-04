import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, DISCOVERY_PATH } from "@agent-harness/contracts";
import { startTestEnvironment } from "../../test/helper.js";
import { useCleanups } from "../../test/cleanups.js";
const { onCleanup } = useCleanups();

it("an admin explicitly admits one HTTPS client for discovery, preflight, pairing and WS", async () => {
  const t = await startTestEnvironment(); onCleanup(() => t.close());
  const admin = await t.client();
  const origin = "https://client.example.test:8443";
  const base = `http://127.0.0.1:${t.address.port}`;
  expect((await fetch(base + DISCOVERY_PATH, { headers: { Origin: origin } })).status).toBe(403);
  await admin.apply("web.origins.set", { commandId: randomUUID(), clientOrigins: [origin], connectOrigins: ["https://second.example.test"] });
  const discovery = await fetch(base + DISCOVERY_PATH, { headers: { Origin: origin } });
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get("access-control-allow-origin")).toBe(origin);
  expect(discovery.headers.get("access-control-allow-credentials")).toBeNull();
  const preflight = await fetch(base + "/api/pair", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  expect(preflight.status).toBe(204);
  const pairing = await t.createPairing({ scopes: ["read"], ceiling: "plan" });
  const paired = await fetch(base + "/api/pair", { method: "POST", headers: { Origin: origin, "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, kind: "web", label: "Test phone", protocolVersion: PROTOCOL_VERSION }) });
  expect(paired.status).toBe(200);
  expect(paired.headers.get("access-control-allow-origin")).toBe(origin);
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { origin });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.terminate();
  expect((await fetch(base + DISCOVERY_PATH, { headers: { Origin: "https://unapproved.example.test" } })).status).toBe(403);
  await admin.apply("web.origins.set", { commandId: randomUUID(), clientOrigins: [], connectOrigins: [] });
  expect((await fetch(base + DISCOVERY_PATH, { headers: { Origin: origin } })).status).toBe(403);
});
it("only admin can configure origins, and malformed or overbroad origins never change trust", async () => {
  const t = await startTestEnvironment(); onCleanup(() => t.close());
  const admin = await t.client();
  const credential = await t.pair({ scopes: ["read"], ceiling: "plan" });
  const reader = await t.client({ token: credential.token });
  await expect(reader.request("web.origins.set", { commandId: randomUUID(), clientOrigins: ["https://client.example.test"], connectOrigins: [] })).rejects.toMatchObject({ code: "forbidden" });
  for (const origin of ["*", "http://client.example.test", "https://client.example.test/", "https://CLIENT.example.test", "https://client.example.test:443", "https://user@client.example.test", "https://client.example.test/path"]) {
    await expect(admin.request("web.origins.set", { commandId: randomUUID(), clientOrigins: [origin], connectOrigins: [] })).rejects.toMatchObject({ code: "invalid_params" });
  }
  expect(await reader.request("web.origins.get", {})).toEqual({ clientOrigins: [], connectOrigins: [] });
});
it("the explicit policy survives an environment restart and remains revocable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-origin-restart-"));
  onCleanup(() => rmSync(directory, { recursive: true, force: true }));
  const t = await startTestEnvironment({ dataDir: directory }); onCleanup(() => t.close());
  const settings = { clientOrigins: ["https://client.example.test"], connectOrigins: ["https://second.example.test:8443"] };
  await (await t.client()).apply("web.origins.set", { commandId: randomUUID(), ...settings });
  await t.close();
  const restarted = await startTestEnvironment({ dataDir: directory }); onCleanup(() => restarted.close());
  const admin = await restarted.client();
  expect(await admin.request("web.origins.get", {})).toEqual(settings);
  await admin.apply("web.origins.set", { commandId: randomUUID(), clientOrigins: [], connectOrigins: [] });
  expect(await admin.request("web.origins.get", {})).toEqual({ clientOrigins: [], connectOrigins: [] });
});
it("the browser bundle admits only configured HTTPS targets and their secure WebSockets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-origin-assets-"));
  onCleanup(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "index.html"), "<html></html>");
  const t = await startTestEnvironment({ webClientDirectory: directory }); onCleanup(() => t.close());
  await (await t.client()).apply("web.origins.set", { commandId: randomUUID(), clientOrigins: [], connectOrigins: ["https://second.example.test:8443"] });
  const page = await fetch(`http://127.0.0.1:${t.address.port}/`);
  const csp = page.headers.get("content-security-policy");
  expect(csp).toContain("https://second.example.test:8443 wss://second.example.test:8443");
  expect(csp).not.toContain("connect-src *");
});
