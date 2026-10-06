import { randomUUID, createECDH, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { startTestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { useCleanups } from "../../test/cleanups.js";
const { onCleanup, tempDir } = useCleanups();

it("read clients learn only the public key, own separate registrations, and cannot test another client's subscription", async () => {
  const environment = await startTestEnvironment({ webOrigin: "https://example.test:8443" });
  onCleanup(() => environment.close());
  const { id: sessionId } = await create(await environment.client());
  const phone = await environment.pair({ kind: "web", scopes: ["read"] });
  const other = await environment.pair({ kind: "web", scopes: ["read"] });
  const a = await environment.client({ token: phone.token });
  const b = await environment.client({ token: other.token });
  const answer = await a.request("attention.push.key", {});
  expect(Object.keys(answer)).toEqual(["publicKey"]);
  expect(Buffer.from(answer.publicKey, "base64url")).toHaveLength(65);
  const browser = createECDH("prime256v1"); browser.generateKeys();
  const target = { id: `push-${phone.clientSessionId}`, label: "Chrome on Android, enabled 6 Oct, 13:04", transport: "push", enabled: true, completion: false, configuration: { endpoint: "https://fcm.googleapis.com/fcm/send/test-registration", p256dh: browser.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } as const;
  await a.apply("attention.targets.set", { commandId: randomUUID(), target });
  expect((await b.request("attention.targets.list", {})).targets).toEqual([]);
  expect(await b.call("attention.push.test", { id: target.id, sessionId })).toMatchObject({ error: { code: "forbidden" } });
  expect((await b.request("attention.targets.set", { commandId: randomUUID(), target })).receipt).toMatchObject({ reason: "forbidden" });
  await b.apply("attention.targets.set", { commandId: randomUUID(), target: { ...target, id: `push-${other.clientSessionId}` } });
  environment.env.clientSessions.revoke(phone.clientSessionId);
  expect((await b.request("attention.targets.list", {})).targets).toHaveLength(1);
});

it("retains the application key after restart", async () => {
  const dataDir = tempDir();
  const environment = await startTestEnvironment({ dataDir, webOrigin: "https://example.test" });
  onCleanup(() => environment.close());
  const client = await environment.client();
  const key = await client.request("attention.push.key", {});
  await environment.close();
  const again = await startTestEnvironment({ dataDir, webOrigin: "https://example.test" });
  onCleanup(() => again.close());
  const restarted = await again.client();
  expect(await restarted.request("attention.push.key", {})).toEqual(key);
});

it("a stale test retirement preserves the subscription replaced while the gateway was responding", async () => {
  const { registerAttentionTransport } = await import("../web/attention.js");
  const { createAttentionTransport } = await import("./push.js");
  let started!: () => void;
  const issued = new Promise<void>(resolve => { started = resolve; });
  let finish!: (status: number) => void;
  const response = new Promise<number>(resolve => { finish = resolve; });
  onCleanup(registerAttentionTransport("push", context => createAttentionTransport(context, { post: async () => { started(); return response; } })));
  const environment = await startTestEnvironment({ webOrigin: "https://example.test" });
  onCleanup(() => environment.close());
  const { id: sessionId } = await create(await environment.client());
  const phone = await environment.pair({ kind: "web", scopes: ["read"] });
  const client = await environment.client({ token: phone.token });
  const secondTab = await environment.client({ token: phone.token });
  const browser = createECDH("prime256v1"); browser.generateKeys();
  const target = { id: `push-${phone.clientSessionId}`, transport: "push", enabled: true, completion: false, configuration: { endpoint: "https://fcm.googleapis.com/fcm/send/old-for-tests", p256dh: browser.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } as const;
  await client.apply("attention.targets.set", { commandId: randomUUID(), target });
  const pending = client.request("attention.push.test", { id: target.id, sessionId });
  await issued;
  await secondTab.apply("attention.targets.set", { commandId: randomUUID(), target: { ...target, configuration: { ...target.configuration, endpoint: "https://fcm.googleapis.com/fcm/send/replacement-for-tests" } } });
  finish(410);
  expect(await pending).toEqual({ status: "retire" });
  expect((await client.request("attention.targets.list", {})).targets).toEqual([expect.objectContaining({ id: target.id, state: "ready" })]);
});
