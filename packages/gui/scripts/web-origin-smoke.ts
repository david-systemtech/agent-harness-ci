import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser } from "playwright";
import { DISCOVERY_PATH, pairingPreset } from "@agent-harness/contracts";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { create } from "../../environment/test/sessions.js";

/** Hosted real-bundle proof: two isolated environments, each retaining its own sessions and authority. */
export const webOriginSmoke = async (browser: Browser, first: TestEnvironment, origin: string, bundle: string, output: string): Promise<void> => {
  assert(process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted");
  let upstream: TestEnvironment | undefined;
  const secure = createServer({ key: readFileSync(join(output, "key.pem")), cert: readFileSync(join(output, "cert.pem")) }, (incoming, response) => {
    if (!upstream) { response.writeHead(503).end(); return; }
    const target = request({ host: upstream.address.host, port: upstream.address.port, method: incoming.method, path: incoming.url, headers: incoming.headers }, answer => { response.writeHead(answer.statusCode ?? 500, answer.headers); answer.pipe(response); });
    target.on("error", () => response.destroy()); incoming.pipe(target);
  });
  secure.on("upgrade", (incoming, socket, head) => {
    if (!upstream) { socket.destroy(); return; }
    const target = connect(upstream.address.port, upstream.address.host, () => {
      const headers = Object.entries(incoming.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
      target.write(`${incoming.method ?? "GET"} ${incoming.url ?? "/ws"} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) target.write(head); socket.pipe(target); target.pipe(socket);
    });
    target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy()); socket.on("close", () => target.destroy());
  });
  await new Promise<void>(resolve => secure.listen(0, "127.0.0.1", resolve));
  const secondOrigin = `https://localhost:${(secure.address() as AddressInfo).port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
  try {
    const second = await startTestEnvironment({ name: "Second environment", webOrigin: secondOrigin, webClientDirectory: bundle }); upstream = second;
    const firstAdmin = await first.client(); const secondAdmin = await second.client();
    await firstAdmin.apply("web.origins.set", { commandId: randomUUID(), clientOrigins: [], connectOrigins: [secondOrigin] });
    const firstTitle = `First environment session ${randomUUID()}`; const secondTitle = `Second environment session ${randomUUID()}`;
    await create(firstAdmin, { title: firstTitle }); await create(secondAdmin, { title: secondTitle });
    const phone = pairingPreset("phone");
    const firstCode = await first.createPairing({ scopes: phone.scopes, ceiling: phone.ceiling });
    const page = await context.newPage(); page.setDefaultTimeout(60_000);
    await page.goto(firstCode.link);
    await page.locator('[data-web-grant][data-phase="ready"]').waitFor();
    const denied = await page.evaluate(async url => {
      try { await fetch(url); return false; } catch { return true; }
    }, secondOrigin + DISCOVERY_PATH);
    assert(denied, "Unapproved browser Origin cannot discover a second environment.");
    await secondAdmin.apply("web.origins.set", { commandId: randomUUID(), clientOrigins: [origin], connectOrigins: [] });
    const secondCode = await second.createPairing({ scopes: phone.scopes, ceiling: phone.ceiling });
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Pair with an environment", exact: true }).click();
    await page.getByRole("textbox", { name: "Pairing link", exact: true }).fill(secondCode.link);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("heading", { name: "Pair with this environment", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Show sessions", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Sessions", exact: true });
    await drawer.getByText(firstTitle, { exact: true }).waitFor();
    await drawer.getByText(secondTitle, { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Show sessions", exact: true }).click();
    await drawer.getByText(firstTitle, { exact: true }).waitFor(); await drawer.getByText(secondTitle, { exact: true }).waitFor();
    console.log("WEB-ORIGIN-SMOKE PASS: explicit Origin approval, two real environments, merged sessions and reload");
  } finally {
    await context.close(); await upstream?.close();
    secure.closeAllConnections(); await new Promise<void>(resolve => secure.close(() => resolve()));
  }
};
