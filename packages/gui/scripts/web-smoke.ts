import { phoneInstallSmoke, waitForPublicWorker } from "./phone-install-smoke.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { pairingPreset, ClientSessionCredential } from "@agent-harness/contracts";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { create } from "../../environment/test/sessions.js";
import { fakeAdapter, end, say } from "../../environment/test/fake-adapter.js";
import type { Address } from "../../environment/src/serve/http.js";

// No shared-box browser or environment process; this executable belongs to hosted CI alone.
assert(process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted", "Web smoke runs only on hosted CI.");
assert(process.getuid?.() !== 0, "The real environment smoke must run as an ordinary uid.");
const output = process.env["WEB_SMOKE_OUTPUT"];
const bundle = process.env["WEB_SMOKE_BUNDLE"];
assert(output && bundle, "The hosted workflow must supply its build and output directories.");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(output, "key.pem"), "-out", join(output, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
let upstream: Address | undefined = undefined;
const publicRequests: { path: string; mode: string | undefined; status?: number; finished: boolean }[] = [];
const secure = createServer({ key: readFileSync(join(output, "key.pem")), cert: readFileSync(join(output, "cert.pem")) }, (incoming, response) => {
  if (!upstream) { response.writeHead(503).end(); return; }
  const path = incoming.url ?? "";
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
  if (!upstream) { socket.destroy(); return; }
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
const adapter = fakeAdapter({ script: async function* ({ input, context }) {
  releaseStream = undefined;
  const itemId = randomUUID();
  const reply = `Streaming the hosted reply: ${input.prompt.at(-1)?.text ?? ""}`;
  yield { type: "assistant.delta", payload: { itemId, fragments: [{ kind: "text", text: `${reply} ` }] } };
  await new Promise<void>(resolve => { releaseStream = resolve; });
  yield say(reply, itemId);
  const decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: { toolName: "Bash", toolCallId: "web-smoke-tool", input: { command: "printf smoke" }, summary: "Run the scripted smoke command" } });
  yield say(`Permission ${decision.decision}.`); yield end();
} });
const environment = await startTestEnvironment({ adapter, webOrigin: origin, webClientDirectory: bundle });
upstream = environment.address;
try {
  const admin = await environment.client();
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]] as const) {
    publicRequests.length = 0;
    const { id: sessionId } = await create(admin, { title: `Hosted phone conversation (${name})`, mode: "acceptEdits" });
    const context = await engine.launchPersistentContext(join(output, `profile-${name}`), {
      viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true,
      ...(name === "chromium" ? { args: ["--ignore-certificate-errors"] } : {}),
    });
    const browser = context.browser(); assert(browser, "The persistent client profile belongs to the hosted browser.");
    try {
      const page = await context.newPage();
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
      await page.reload();
      await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
      await page.getByRole("combobox", { name: "Sessions", exact: true }).selectOption(`${environment.env.id}/${sessionId}`);
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Allow this scripted reply.");
      await page.getByRole("button", { name: /^Send/ }).click();
      await page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: "Streaming the hosted reply: Allow this scripted reply." }).last().waitFor();
      assert(releaseStream, "The streamed reply reached the browser before completion."); releaseStream();
      await page.getByRole("button", { name: /^Allow once/ }).click();
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
      try { await phoneInstallSmoke(page, context, bundle, name); }
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
      await ownPage.goto(ownCode.link);
      await ownPage.locator("[data-web-grant]").filter({ hasText: "Ceiling: bypassPermissions" }).waitFor();
      assert((await ownPage.locator("[data-web-grant]").innerText()).includes("terminal, admin"), "My own client keeps its full grant.");
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
      console.log(`WEB-SMOKE PASS ${name}: pair/reload, list/open, stream, Allow/Deny once, reconnect, grants, revoke, visit-only storage`);
    } finally { await browser.close(); }
  }
} finally {
  await environment.close();
  secure.closeAllConnections(); await new Promise<void>(resolve => secure.close(() => resolve()));
}
