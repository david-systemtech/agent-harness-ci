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
  assert.equal(await page.evaluate("Notification.permission"), "granted", "Hosted Chromium must provide its native notification service.");
  await page.evaluate(`(() => {
    const subscription = ${JSON.stringify(gateway.subscription)};
    let active = false;
    const value = { toJSON: () => subscription, unsubscribe: async () => { active = false; return true; } };
    PushManager.prototype.getSubscription = async () => active ? value : null;
    PushManager.prototype.subscribe = async () => { active = true; return value; };
  })()`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Attention settings", exact: true }).click();
  await page.getByRole("button", { name: "Enable push", exact: true }).click();
  await expect(page.getByRole("region", { name: "Web Push" })).toContainText("Push enabled for this client.", { timeout: 60_000 });
  await page.getByRole("button", { name: "Close attention settings", exact: true }).click();
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
  // Headless Chromium cannot dispatch an OS tap: script-created ExtendableEvents
  // have no lifetime observer/window-interaction token. Double that OS boundary,
  // while dispatching the actual notification to the production worker handler.
  const clicked = await worker.evaluate<string>(`(async () => {
    const notifications = await registration.getNotifications();
    const notification = notifications.find(item => item.data?.url === ${JSON.stringify(payload.url)});
    if (!notification) throw new Error("Notification unavailable.");
    let opened;
    const pending = [];
    Object.defineProperty(clients, "openWindow", { configurable: true, value: async url => {
      if (opened) throw new Error("The tap opened more than one window.");
      opened = url;
      return null;
    } });
    try {
      const event = new NotificationEvent("notificationclick", { notification });
      Object.defineProperty(event, "waitUntil", { value: promise => pending.push(promise) });
      self.dispatchEvent(event);
      await Promise.all(pending);
      if (!opened) throw new Error("The notification did not request a window.");
      return opened;
    } finally { delete clients.openWindow; }
  })()`);
  assert.equal(clicked, payload.url);
  const returned = await context.newPage();
  await returned.goto(clicked);
  await expect(returned).toHaveURL(payload.url);
  await returned.locator('[data-web-grant][data-phase="ready"]').waitFor();
  await returned.close(); await observer.close(); await wire.close();
  const replacement = await context.newPage();
  console.log("PHONE-PUSH PASS chromium: encrypted HTTPS gateway, closed page, real worker notification, OS-tap boundary double and same-origin click return");
  return replacement;
}
