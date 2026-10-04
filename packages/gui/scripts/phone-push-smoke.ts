import assert from "node:assert/strict";
import { createECDH, randomBytes, hkdfSync, createDecipheriv } from "node:crypto";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "playwright";
import { expect } from "playwright/test";
import { createAttentionTransport } from "../../environment/src/attention/push.js";
import { registerAttentionTransport } from "../../environment/src/web/attention.js";
import type { TestEnvironment } from "../../environment/test/helper.js";

/** A vendor gateway double receives actual HTTPS encrypted requests; its browser keys exist only in this fixture. */
export async function phonePushGateway(key: Buffer, cert: Buffer) {
  const browser = createECDH("prime256v1"); browser.generateKeys();
  const auth = randomBytes(16);
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/hosted-test-registration", keys: { p256dh: browser.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  const payloads: string[] = [];
  const gateway = createServer({ key, cert }, async (incoming, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      assert.equal(incoming.headers["content-encoding"], "aes128gcm");
      assert.match(incoming.headers.authorization ?? "", /^vapid t=.+, k=.+$/);
      assert(!body.includes(Buffer.from("A session needs you")), "The gateway sees encrypted notification bytes.");
      const server = body.subarray(21, 21 + body[20]!);
      const ikm = hkdfSync("sha256", browser.computeSecret(server), auth, Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), server]), 32);
      const keyMaterial = hkdfSync("sha256", Buffer.from(ikm), body.subarray(0, 16), Buffer.from("Content-Encoding: aes128gcm\0"), 16);
      const nonce = hkdfSync("sha256", Buffer.from(ikm), body.subarray(0, 16), Buffer.from("Content-Encoding: nonce\0"), 12);
      const cipher = body.subarray(21 + server.length);
      const decipher = createDecipheriv("aes-128-gcm", Buffer.from(keyMaterial), Buffer.from(nonce));
      decipher.setAuthTag(cipher.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]);
      assert.equal(plaintext.at(-1), 2);
      payloads.push(plaintext.subarray(0, -1).toString());
      response.writeHead(201).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const port = (gateway.address() as AddressInfo).port;
  const unregister = registerAttentionTransport("push", context => createAttentionTransport(context, { post: async (_vendor, body, headers, signal) => new Promise<number>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path: "/push", method: "POST", rejectUnauthorized: false, headers, signal }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    outgoing.on("error", reject); outgoing.end(body);
  }) }));
  return { subscription, payloads, close: async () => { unregister(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); } };
}

/** Native worker + notification APIs; the gateway/PushManager double replaces the external browser-vendor account. */
export async function phonePushSmoke({ context, page, environment, token, sessionId, gateway }: {
  readonly context: BrowserContext; readonly page: Page; readonly environment: TestEnvironment;
  readonly token: string; readonly sessionId: string; readonly gateway: Awaited<ReturnType<typeof phonePushGateway>>;
}) {
  await context.grantPermissions(["notifications"], { origin: new URL(page.url()).origin });
  await page.evaluate(`(() => {
    const subscription = ${JSON.stringify(gateway.subscription)};
    let active = false;
    const value = { toJSON: () => subscription, unsubscribe: async () => { active = false; return true; } };
    PushManager.prototype.getSubscription = async () => active ? value : null;
    PushManager.prototype.subscribe = async () => { active = true; return value; };
  })()`);
  await page.getByText("Phone notifications", { exact: true }).click();
  await page.getByRole("button", { name: "Enable push", exact: true }).click();
  await page.getByText("Push enabled for this client.", { exact: true }).waitFor();
  await page.getByText("Phone notifications", { exact: true }).click();
  const worker = context.serviceWorkers().find(item => new URL(item.url()).pathname === "/service-worker.js");
  assert(worker, "The real bundled service worker is running.");
  const observer = await context.newPage();
  const cdp = await context.newCDPSession(observer);
  let registrationId: string | undefined;
  cdp.on("ServiceWorker.workerRegistrationUpdated", event => {
    registrationId = event.registrations.find((registration: { scopeURL: string }) => registration.scopeURL === `${new URL(page.url()).origin}/`)?.registrationId ?? registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrationId, { timeout: 60_000 }).toBeTruthy();
  const origin = new URL(page.url()).origin;
  const wire = await environment.client({ token });
  const targets = await wire.request("attention.targets.list", {});
  const target = targets.targets.find(item => item.transport === "push");
  assert(target);
  await page.close();
  assert.equal(context.pages().filter(item => item.url().startsWith(origin)).length, 0, "The client page is closed before delivery.");
  const before = gateway.payloads.length;
  assert.deepEqual(await wire.request("attention.push.test", { id: target.id, sessionId }), { status: "sent" });
  assert.equal(gateway.payloads.length, before + 1);
  const payload = JSON.parse(gateway.payloads.at(-1)!) as { message: string; url: string };
  assert.deepEqual(payload, { message: "A session needs you", url: `${origin}/#/session/${encodeURIComponent(environment.env.id)}/${encodeURIComponent(sessionId)}` });
  await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId: registrationId!, data: JSON.stringify(payload) });
  await expect.poll(() => worker.evaluate<string[]>("registration.getNotifications().then(items => items.map(item => item.title))"), { timeout: 60_000 }).toContain("A session needs you");
  // DevTools supplies the user gesture a notification tap supplies on a handset.
  const browserCdp = await context.browser()!.newBrowserCDPSession();
  const targetsInfo = await browserCdp.send("Target.getTargets");
  const workerTarget = targetsInfo.targetInfos.find((item: { type: string; url: string }) => item.type === "service_worker" && item.url === worker.url());
  assert(workerTarget);
  const attached = await browserCdp.send("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: false });
  const opened = context.waitForEvent("page", { timeout: 60_000 });
  await browserCdp.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { userGesture: true, expression: "void registration.getNotifications().then(items => self.dispatchEvent(new NotificationEvent('notificationclick', { notification: items[0] })))" } }) });
  const returned = await opened;
  await expect(returned).toHaveURL(payload.url);
  await returned.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
  await returned.close(); await observer.close(); await wire.close(); await browserCdp.detach();
  const replacement = await context.newPage();
  console.log("PHONE-PUSH PASS chromium: encrypted HTTPS gateway, closed page, real worker notification and same-origin click return");
  return replacement;
}
