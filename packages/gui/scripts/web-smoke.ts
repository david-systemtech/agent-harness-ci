import { phoneDocument, phoneFrameSmoke, phonePaneSmoke, phoneReconnectSmoke, reachable } from "../test/web-client/phone-surfaces.js";
import { phoneFallback } from "../test/web-client/phone-fallback.js";
import { phoneRefusalSmoke } from "./phone-refusal-smoke.js";
import { phonePushGateway, phonePushSmoke } from "./phone-push-smoke.js";
import { webOriginSmoke } from "./web-origin-smoke.js";
import { auditPublicCache, phoneInstallSmoke, waitForPublicWorker } from "./phone-install-smoke.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { expect } from "playwright/test";
import { pairingPreset, ClientSessionCredential } from "@agent-harness/contracts";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { create } from "../../environment/test/sessions.js";
import { fakeAdapter, end, say, signedInAs } from "../../environment/test/fake-adapter.js";
import type { Address } from "../../environment/src/serve/http.js";

// No shared-box browser or environment process; this executable belongs to hosted CI alone.
assert(process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted", "Web smoke runs only on hosted CI.");
assert(process.getuid?.() !== 0, "The real environment smoke must run as an ordinary uid.");
const output = process.env["WEB_SMOKE_OUTPUT"];
const bundle = process.env["WEB_SMOKE_BUNDLE"];
assert(output && bundle, "The hosted workflow must supply its build and output directories.");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(output, "key.pem"), "-out", join(output, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
let upstream: Address | undefined = undefined;
let originAvailable = true;
const clientSockets = new Set<import("node:stream").Duplex>();
const previewRequests: string[] = [];
const publicRequests: { path: string; mode: string | undefined; status?: number; finished: boolean }[] = [];
const secure = createServer({ key: readFileSync(join(output, "key.pem")), cert: readFileSync(join(output, "cert.pem")) }, (incoming, response) => {
  const path = incoming.url ?? "";
  if (path.startsWith("/preview-probe-")) previewRequests.push(path);
  if (!originAvailable) { response.destroy(); return; }
  if (!upstream) { response.writeHead(503).end(); return; }
  const publicRequest: (typeof publicRequests)[number] | undefined = /^\/(?:assets\/[a-zA-Z0-9_.-]+|phone-icons\/[a-zA-Z0-9_.-]+|manifest\.webmanifest)?$/.test(path)
    ? { path, mode: incoming.headers["sec-fetch-mode"]?.toString(), finished: false } : undefined;
  if (publicRequest) {
    publicRequests.push(publicRequest);
    response.on("finish", () => { publicRequest.finished = true; });
  }
  const forwarded = request({ host: upstream.host, port: upstream.port, method: incoming.method, path: incoming.url, headers: incoming.headers }, result => {
    if (publicRequest && result.statusCode !== undefined) publicRequest.status = result.statusCode;
    response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response);
  });
  forwarded.on("error", () => response.destroy()); incoming.pipe(forwarded);
});
secure.on("upgrade", (incoming, socket, head) => {
  if (!originAvailable || !upstream) { socket.destroy(); return; }
  clientSockets.add(socket);
  socket.on("close", () => clientSockets.delete(socket));
  const target = connect(upstream.port, upstream.host, () => {
    const headers = Object.entries(incoming.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
    target.write(`${incoming.method ?? "GET"} ${incoming.url ?? "/ws"} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head.length) target.write(head);
    socket.pipe(target); target.pipe(socket);
  });
  target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy()); socket.on("close", () => target.destroy());
});
await new Promise<void>(resolve => secure.listen(0, "127.0.0.1", resolve));
const origin = `https://localhost:${(secure.address() as AddressInfo).port}`;
let releaseStream: (() => void) | undefined;
const adapter = fakeAdapter({ script: async function* (controls) {
  const { input, context } = controls;
  releaseStream = undefined;
  const itemId = randomUUID();
  const reply = `Streaming the hosted reply: ${input.prompt.at(-1)?.text ?? ""}`;
  yield { type: "assistant.delta", payload: { itemId, fragments: [{ kind: "text", text: `${reply} ` }] } };
  await new Promise<void>(resolve => { releaseStream = resolve; });
  yield say(reply, itemId);
  const decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: { toolName: "Bash", toolCallId: "web-smoke-tool", input: { command: "printf smoke" }, summary: "Run the scripted smoke command" } });
  yield say(`Permission ${decision.decision}.`);
  if (decision.decision === "allow") yield* phoneDocument(controls);
  yield end();
} });
const pushGateway = await phonePushGateway(readFileSync(join(output, "key.pem")), readFileSync(join(output, "cert.pem")));
const environment = await startTestEnvironment({ adapter, webOrigin: origin, webClientDirectory: bundle });
upstream = environment.address;
try {
  const admin = await environment.client();
  for (const [name, engine] of [["webkit", webkit], ["chromium", chromium]] as const) {
    publicRequests.length = 0;
    const workspace = join(output, `phone-workspace-${name}`); mkdirSync(workspace);
    const fallback = await phoneFallback(environment);
    const { id: sessionId } = await create(admin, { workspace: { kind: "directory", path: workspace }, title: `Hosted phone conversation (${name})`, mode: "acceptEdits" });
    const browser = await engine.launch(name === "chromium" ? { channel: "chromium", args: ["--ignore-certificate-errors"] } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    try {
      let page = await context.newPage();
      page.setDefaultTimeout(60_000);
      const errors: string[] = [];
      const requests: string[] = [];
      const credentials: ReturnType<typeof ClientSessionCredential.parse>[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", req => requests.push(req.url()));
      page.on("response", async res => {
        if (new URL(res.url()).pathname === "/api/pair" && res.status() === 200) credentials.push(ClientSessionCredential.parse(await res.json()));
      });
      const phone = pairingPreset("phone");
      const code = await environment.createPairing({ scopes: phone.scopes, ceiling: phone.ceiling });
      assert(code.link.startsWith(`${origin}/pair#`), "Canonical HTTPS links retain their port.");
      await page.goto(code.link);
      await page.locator("[data-web-grant]").filter({ hasText: "Ceiling: acceptEdits" }).waitFor();
      assert.equal(new URL(page.url()).hash, "", "Pairing credentials leave the address bar.");
      try { await waitForPublicWorker(page, name); }
      catch (error) { console.error(`PHONE-INSTALL ${name}: public requests ${JSON.stringify(publicRequests)}`); throw error; }
      await auditPublicCache(page, name, "initial installation");
      await page.reload();
      await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
      await page.getByRole("button", { name: "Show sessions", exact: true }).click();
      await page.getByRole("dialog", { name: "Sessions", exact: true }).locator("[data-sidebar-row]").filter({ hasText: `Hosted phone conversation (${name})` }).click();
      await page.getByRole("dialog", { name: "Sessions", exact: true }).waitFor({ state: "hidden" });
      if (name === "chromium") {
        assert(credentials[0]);
        page = await phonePushSmoke({ context, page, environment, token: credentials[0].token, sessionId, gateway: pushGateway });
        page.setDefaultTimeout(60_000);
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", req => requests.push(req.url()));
        await page.goto(`${origin}/#/session/${encodeURIComponent(environment.env.id)}/${encodeURIComponent(sessionId)}`);
        await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      }
      await phoneFrameSmoke(page, name);
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Allow this scripted reply.");
      await page.getByRole("button", { name: /^Send/ }).click();
      await page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: "Streaming the hosted reply: Allow this scripted reply." }).last().waitFor();
      assert(releaseStream, "The streamed reply reached the browser before completion.");
      await phoneReconnectSmoke(page, environment, sessionId, releaseStream, available => {
        originAvailable = available;
        if (!available) for (const socket of clientSockets) socket.destroy();
      });
      await page.getByRole("button", { name: /^Allow once/ }).waitFor();
      await page.setViewportSize({ width: 390, height: 460 });
      // Waiting cards scroll in the region above the composer at keyboard height.
      await page.getByRole("button", { name: /^Allow once/ }).scrollIntoViewIfNeeded();
      await reachable(page, page.getByRole("button", { name: /^Allow once/ }));
      await fallback.verify(sessionId, origin, name);
      await page.getByRole("button", { name: /^Allow once/ }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByText("Permission allow.", { exact: true }).last().waitFor();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Deny this scripted reply.");
      await page.getByRole("button", { name: /^Send/ }).click();
      await page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: "Streaming the hosted reply: Deny this scripted reply." }).last().waitFor();
      assert(releaseStream); releaseStream();
      await page.getByRole("button", { name: /^Deny/ }).click();
      await page.getByText("Permission deny.", { exact: true }).last().waitFor();
      assert.equal(adapter.runs.slice(-2).reduce((count, run) => count + run.answers.length, 0), 2, "Each permission is answered exactly once.");
      await context.setOffline(true); await context.setOffline(false);
      await page.reload();
      await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      await phoneRefusalSmoke(page, name, output, async signedIn => {
        adapter.setStatus(account => signedInAs(signedIn ? `${account.id}@example.com` : null));
        await admin.request("accounts.refresh", { accountId: "claude-max" });
      }, async message => {
        await expect.poll(async () => (await admin.request("sessions.get", { sessionId })).summary.draft, {
          timeout: 60_000, message: "The real environment holds the refused draft before reload.",
        }).toBe(message);
      });
      try { await phoneInstallSmoke(page, bundle, name, available => { originAvailable = available; }); }
      catch (error) { console.error(`PHONE-INSTALL ${name}: public requests ${JSON.stringify(publicRequests)}`); throw error; }
      const credential = credentials[0]; assert(credential, "The browser completed pairing.");
      const wire = await environment.client({ token: credential.token, clientKind: "web" });
      await assert.rejects(() => wire.request("access.sessions.list", {}), "Phone has no admin scope.");
      const clamp = await wire.apply("permissions.mode.set", { commandId: randomUUID(), sessionId, mode: "bypassPermissions" });
      assert.equal(clamp.mode.effective, "acceptEdits", "The Phone ceiling is enforced.");
      await admin.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: credential.clientSessionId });
      await page.locator("[data-web-grant]").filter({ hasText: "blocked" }).waitFor();
      await page.reload();
      assert.equal(await page.evaluate(`(async () => { const request = indexedDB.open('agent-harness-secrets'); const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const read = db.transaction('secrets').objectStore('secrets').get(${JSON.stringify(environment.env.id)}); return await new Promise(resolve => { read.onsuccess = () => resolve(read.result === undefined); }); })()`), true, "Revocation erases the credential.");
      const own = pairingPreset("own-client");
      const ownCode = await environment.createPairing({ scopes: own.scopes, ceiling: own.ceiling });
      // An independent browser storage context proves this separately minted grant.
      const ownContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
      const ownPage = await ownContext.newPage();
      ownPage.setDefaultTimeout(60_000);
      await ownPage.goto(ownCode.link);
      await ownPage.locator("[data-web-grant]").filter({ hasText: "Ceiling: bypassPermissions" }).waitFor();
      assert((await ownPage.locator("[data-web-grant]").innerText()).includes("terminal, admin"), "My own client keeps its full grant.");
      await ownPage.getByRole("button", { name: "Show sessions", exact: true }).click();
      const ownDrawer = ownPage.getByRole("dialog", { name: "Sessions", exact: true });
      await ownDrawer.locator("[data-sidebar-row]").filter({ hasText: `Hosted phone conversation (${name})` }).click();
      await ownDrawer.waitFor({ state: "hidden" });
      await ownPage.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      await phonePaneSmoke(ownPage, name, environment, sessionId, () => previewRequests);
      await ownContext.close();
      const denied = await browser.newContext({ viewport: { width: 360, height: 740 }, ignoreHTTPSErrors: true });
      await denied.addInitScript("Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Denied', 'SecurityError'); } });");
      const visit = await denied.newPage();
      const visitCode = await environment.createPairing({ scopes: phone.scopes, ceiling: phone.ceiling });
      await visit.goto(visitCode.link);
      await visit.getByText(/Storage is unavailable. Pair for this visit/).waitFor();
      await visit.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
      await visit.reload();
      await visit.getByRole("heading", { name: "Pair with this environment" }).waitFor();
      assert(requests.every(url => !url.includes(code.code) && !url.includes(credential.token)), "No token or code reaches a request URL.");
      assert.equal(errors.length, 0, "The real bundle produced no page errors.");
      await context.close(); await denied.close();
      await webOriginSmoke(browser, environment, origin, bundle, output);
      console.log(`WEB-SMOKE PASS ${name}: pair/reload, list/open, stream, Allow/Deny once, reconnect, grants, revoke, visit-only storage`);
    } finally { await browser.close(); await fallback.close(); }
  }
} finally {
  await environment.close();
  await pushGateway.close();
  secure.closeAllConnections(); await new Promise<void>(resolve => secure.close(() => resolve()));
}
