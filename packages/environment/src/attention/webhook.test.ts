import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ask, end, fakeAdapter } from "../../test/fake-adapter.js";
import { create } from "../../test/sessions.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { fileVault, VAULT_FILE, type Vault } from "../serve/vault.js";
import { created, ranNow, routineCommand, written, untilEvent, untilRoutineEvent, untilStarted } from "../../test/routines.js";
import { verifyStandardWebhook, webhookReceiver, type WebhookReceiver } from "../../test/webhook-receiver.js";
import { attentionStore, attentionStream } from "./store.js";

const { onCleanup, tempDir } = useCleanups();
const SECRET = "token-for-tests";
const target = { id: "fallback", transport: "webhook", enabled: true, completion: false, configuration: { endpoint: "attention" } } as const;
const adapter = () => fakeAdapter({ script: ask("question", { questions: [{ header: "Choice", question: "private-prompt-for-tests", options: [], multiSelect: false }] }, { promptId: "prompt-1" }) });

const start = async (options: { readonly dataDir?: string; readonly vault?: Vault } = {}) => {
  const receiver = await webhookReceiver();
  onCleanup(() => receiver.close());
  const t = await startTestEnvironment({ dataDir: tempDir(), webOrigin: "https://example.test:8443", adapter: adapter(), ...options });
  onCleanup(() => t.close());
  const client = await t.client();
  await client.apply("routines.endpoints.set", { commandId: randomUUID(), name: "attention", url: `${receiver.origin}/attention`, secret: { kind: "pasted", secret: SECRET } });
  await client.apply("attention.routes.set", { commandId: randomUUID(), target });
  return { t, client, receiver };
};
const park = async (t: TestEnvironment) => {
  const driver = await t.client();
  const { id } = await create(driver);
  await driver.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Ask one question" });
  await untilEvent(t, { kind: "session", id }, e => e.type === "prompt.opened");
  return id;
};
const attempt = async (t: TestEnvironment, ms: number) => {
  const after = t.env.log.head();
  t.clock.advance(ms);
  const outcome = await untilEvent(t, attentionStream, e => e.sequence > after && e.type === "attention.delivery.result");
  // A wire round trip lets the completed network attempt release its in-flight slot before advancing time again.
  const observer = await t.client();
  await observer.request("attention.targets.list", {});
  await observer.close();
  return outcome;
};
const verified = (receiver: WebhookReceiver, t: TestEnvironment, sessionId: string) => {
  const request = receiver.received.at(-1)!;
  expect(verifyStandardWebhook(SECRET, request, t.clock.now())).toBe(true);
  expect(request.method).toBe("POST");
  expect(request.path).toBe("/attention");
  expect(JSON.parse(request.body)).toEqual({ message: "A session needs you", url: `https://example.test:8443/#/session/${t.env.id}/${sessionId}` });
  expect(verifyStandardWebhook(SECRET, { ...request, body: request.body + " " }, t.clock.now())).toBe(false);
  expect(verifyStandardWebhook(SECRET, request, new Date(t.clock.now().getTime() + 301_000))).toBe(false);
  expect(request.body).not.toContain(SECRET);
  expect(request.body).not.toContain("private-prompt-for-tests");
  return request;
};

it("loads the webhook transport and sends a signed generic HTTPS session link to a named endpoint", async () => {
  const { t, client, receiver } = await start();
  expect((await client.request("attention.targets.list", {})).targets[0]?.state).toBe("ready");
  const sessionId = await park(t);
  await attempt(t, 6000);
  expect(receiver.received).toHaveLength(1);
  verified(receiver, t, sessionId);
  expect((await client.request("attention.targets.list", {})).targets).toEqual([{ id: "fallback", transport: "webhook", webhookEndpoint: "attention", enabled: true, completion: false, global: true, state: "ready", failure: null }]);
});

it("rechecks the host denylist when delivering an already configured endpoint", async () => {
  const { t, client, receiver } = await start();
  await client.apply("permissions.denylist.set", { commandId: randomUUID(), sections: { hosts: [{ pattern: "127.0.0.1" }] } });
  await park(t);
  await attempt(t, 6000);
  expect(receiver.received).toEqual([]);
  expect((await client.request("attention.targets.list", {})).targets[0]).toMatchObject({ state: "failed", failure: "Delivery failed. Check the configured transport." });
});

it("keeps the receiver's idempotency key and refreshes the timestamp across retry and environment restart", async () => {
  const { t, client, receiver } = await start();
  receiver.answer({ status: 503 });
  const sessionId = await park(t);
  await attempt(t, 6000);
  const first = verified(receiver, t, sessionId);
  expect((await client.request("attention.targets.list", {})).targets[0]).toMatchObject({ state: "failed", failure: "Delivery failed. Check the configured transport." });
  await t.close();
  const again = await startTestEnvironment({ dataDir: t.dataDir, clock: t.clock, webOrigin: "https://example.test:8443" });
  onCleanup(() => again.close());
  receiver.answer({ status: 204 });
  await attempt(again, 60_000);
  const second = verified(receiver, again, sessionId);
  expect(second.headers["webhook-id"]).toBe(first.headers["webhook-id"]);
  expect(Number(second.headers["webhook-timestamp"]) - Number(first.headers["webhook-timestamp"])).toBe(60);
  // A receiver that accepted the first POST but lost its response delivers once by this key.
  expect(new Set(receiver.received.map(request => request.headers["webhook-id"])).size).toBe(1);
  const fresh = await again.client();
  expect((await fresh.request("attention.targets.list", {})).targets[0]).toMatchObject({ state: "ready", failure: null });
  again.clock.advance(30 * 60_000);
  await fresh.request("attention.targets.list", {});
  expect(receiver.received).toHaveLength(2);
});

it("bounds failed delivery to the initial attempt and 1/5/30-minute retries with safe Settings status", async () => {
  const { t, client, receiver } = await start();
  receiver.answer({ status: 503 });
  const sessionId = await park(t);
  const times: string[] = [];
  for (const delay of [6000, 60_000, 300_000, 1_800_000]) {
    await attempt(t, delay);
    times.push(String(verified(receiver, t, sessionId).headers["webhook-timestamp"]));
  }
  expect(times.map(Number).map(time => time - Number(times[0]))).toEqual([0, 60, 360, 2160]);
  expect(new Set(receiver.received.map(request => request.headers["webhook-id"])).size).toBe(1);
  t.clock.advance(24 * 60 * 60_000);
  const status = await client.request("attention.targets.list", {});
  expect(receiver.received).toHaveLength(4);
  expect(status.targets[0]).toMatchObject({ state: "failed", failure: "Delivery failed. Check the configured transport." });
  expect(JSON.stringify(status)).not.toContain(SECRET);
  expect(JSON.stringify(t.env.log.readStream(attentionStream))).not.toContain(SECRET);
});

it.each(["queued", "in-flight", "retry"] as const)("cancels %s delivery when a prompt is answered", async stage => {
  const { t, client, receiver } = await start();
  if (stage === "in-flight") receiver.answer("hang");
  if (stage === "retry") receiver.answer({ status: 503 });
  await park(t);
  if (stage === "in-flight") {
    const received = receiver.next();
    t.clock.advance(6000);
    await received;
  } else if (stage === "retry") await attempt(t, 6000);
  await client.apply("permissions.prompts.answer", { commandId: randomUUID(), promptId: "prompt-1", decision: "deny" });
  t.clock.advance(24 * 60 * 60_000);
  await client.request("attention.targets.list", {});
  expect(receiver.received).toHaveLength(stage === "queued" ? 0 : 1);
  expect(attentionStore(t.env.log).deliveries()[0]).toMatchObject({ state: "cancelled" });
});

it("aborts a hanging request at ten seconds using the environment clock", async () => {
  const { t, receiver } = await start();
  receiver.answer("hang");
  await park(t);
  const received = receiver.next();
  t.clock.advance(6000);
  await received;
  const after = t.env.log.head();
  t.clock.advance(9999);
  expect(t.env.log.readStream(attentionStream).some(event => event.type === "attention.delivery.result")).toBe(false);
  t.clock.advance(1);
  const outcome = await untilEvent(t, attentionStream, event => event.sequence > after && event.type === "attention.delivery.result");
  expect(outcome.payload).toMatchObject({ state: "pending", attempts: 1, failure: "Delivery failed. Check the configured transport." });
});

it("refuses redirects instead of forwarding the signed payload to another receiver", async () => {
  const { t, receiver } = await start();
  const destination = await webhookReceiver();
  onCleanup(() => destination.close());
  receiver.answer({ status: 307, headers: { location: `${destination.origin}/unexpected` } });
  await park(t);
  await attempt(t, 6000);
  expect(receiver.received).toHaveLength(1);
  expect(destination.received).toEqual([]);
});

it.each([
  { endpoint: "attention", secret: SECRET },
  { endpoint: "https://example.test/hook" },
  {},
])("refuses attention registration with inline secrets or an unnamed endpoint: %j", async configuration => {
  const { client } = await start();
  const answer = await client.request("attention.routes.set", { commandId: randomUUID(), target: { ...target, configuration } });
  expect(answer.receipt).toMatchObject({ status: "rejected", reason: "invalid_params" });
});

it.each(["removed", "missing-secret"] as const)("fails safely when a configured endpoint is %s", async state => {
  const { t, client, receiver } = await start();
  await client.apply("routines.endpoints.remove", { commandId: randomUUID(), name: "attention" });
  if (state === "missing-secret") await client.apply("routines.endpoints.set", { commandId: randomUUID(), name: "attention", url: `${receiver.origin}/attention` });
  await park(t);
  await attempt(t, 6000);
  expect(receiver.received).toEqual([]);
  expect((await client.request("attention.targets.list", {})).targets[0]).toMatchObject({ state: "failed", failure: "Delivery failed. Check the configured transport." });
});

it.each(["http://@", "http://user:password-for-tests@", "http://\t@"])("refuses userinfo in replayed endpoint URLs, including empty credentials: %s", async prefix => {
  const { t, client, receiver } = await start();
  // Imported/replayed records must still meet outbound policy at delivery time.
  t.env.log.append({ kind: "environment", id: t.env.id }, [{ type: "routine.endpoint-set", payload: {
    name: "attention", url: `${prefix}${receiver.origin.slice("http://".length)}/attention`, secretKind: "pasted",
  } }], { actor: "system:routines" });
  await park(t);
  await attempt(t, 6000);
  expect(receiver.received).toEqual([]);
  expect((await client.request("attention.targets.list", {})).targets[0]).toMatchObject({ state: "failed" });
});

it("resolves a replaced endpoint secret afresh on retry", async () => {
  const { t, client, receiver } = await start();
  receiver.answer({ status: 503 });
  await park(t);
  await attempt(t, 6000);
  const first = receiver.received[0]!;
  await client.apply("routines.endpoints.set", { commandId: randomUUID(), name: "attention", url: `${receiver.origin}/attention`, secret: { kind: "pasted", secret: "other-token-for-tests" } });
  receiver.answer({ status: 204 });
  await attempt(t, 60_000);
  const second = receiver.received[1]!;
  expect(second.headers["webhook-id"]).toBe(first.headers["webhook-id"]);
  expect(verifyStandardWebhook("other-token-for-tests", second, t.clock.now())).toBe(true);
  expect(verifyStandardWebhook(SECRET, second, t.clock.now())).toBe(false);
});

it.each(["http://receiver.example.test/attention", "ftp://receiver.example.test/attention"])("refuses a replayed endpoint outside the outbound scheme policy: %s", async url => {
  const { t, receiver } = await start();
  t.env.log.append({ kind: "environment", id: t.env.id }, [{ type: "routine.endpoint-set", payload: { name: "attention", url, secretKind: "pasted" } }], { actor: "system:routines" });
  await park(t);
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input) === url) { fetched.push(url); return Promise.resolve(new Response(null, { status: 204 })); }
    return originalFetch(input, init);
  });
  onCleanup(() => spy.mockRestore());
  await attempt(t, 6000);
  expect(fetched).toEqual([]);
  expect(receiver.received).toEqual([]);
  expect(attentionStore(t.env.log).status(() => true)[0]).toMatchObject({ state: "failed", failure: "Delivery failed. Check the configured transport." });
});


it("removing the last webhook route removes its named endpoint and vault secret", async () => {
  const dataDir = tempDir();
  const vault = fileVault(join(dataDir, VAULT_FILE));
  let erased!: () => void;
  const secretErased = new Promise<void>(resolve => { erased = resolve; });
  const { t, client } = await start({ dataDir, vault: {
    ...vault,
    async delete(key) { await vault.delete(key); if (key === "endpoint:attention") erased(); },
  } });
  const commandId = randomUUID();
  const removed = await client.apply("attention.routes.remove", { commandId, id: target.id });
  expect((await client.request("attention.targets.list", {})).targets).toEqual([]);
  expect((await client.request("routines.endpoints.list", {})).endpoints).toEqual([]);
  await secretErased;
  expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).not.toContain(SECRET);
  expect(removed).toEqual({ id: target.id, endpoint: { name: "attention", state: "removed", secretKind: "pasted" } });
  expect(await client.request("attention.routes.remove", { commandId, id: target.id })).toMatchObject({ receipt: { status: "accepted" } });
  expect(t.env.log.readStream({ kinds: ["environment"] }).filter(event => event.type === "routine.endpoint-removed")).toHaveLength(1);
});

it.each([true, false])("keeps the endpoint and secret of a routine that is enabled=%s", async enabled => {
  const { t, client } = await start();
  await created(client, written({ enabled, delivery: [{ kind: "webhook", target: "attention", on: "both" }] }));
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toEqual({ id: target.id, endpoint: { name: "attention", state: "retained" } });
  expect((await client.request("attention.targets.list", {})).targets).toEqual([]);
  expect((await client.request("routines.endpoints.list", {})).endpoints).toMatchObject([{ name: "attention" }]);
  expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).toContain(SECRET);
});

it.each(["running", "retrying"] as const)("keeps an endpoint captured by a %s firing after its routine's delivery is edited", async stage => {
  const { t, client, receiver } = await start();
  const routine = await created(client, written({ schedule: { kind: "manual" }, delivery: [{ kind: "webhook", target: "attention", on: "both" }] }));
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  onCleanup(release);
  t.adapter.nextScripts.push(async function* () {
    if (stage === "running") await held;
    yield end("completed", { resultText: "Digest filed." });
  });
  receiver.answer({ status: stage === "retrying" ? 503 : 204 });
  const entryId = await ranNow(client, routine.state.id);
  await untilStarted(t, routine.state.id, entryId);
  if (stage === "retrying") await untilRoutineEvent(t, routine.state.id, event => event.type === "routine.delivery-attempted" && event.payload["entryId"] === entryId && event.payload["result"] === "retrying");
  expect(await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [] } })).toMatchObject({ receipt: { status: "accepted" } });
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toEqual({ id: target.id, endpoint: { name: "attention", state: "retained" } });
  expect((await client.request("routines.endpoints.list", {})).endpoints).toMatchObject([{ name: "attention" }]);
  expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).toContain(SECRET);
  receiver.answer({ status: 204 });
  if (stage === "running") release();
  else t.clock.advance(60_000);
  await untilRoutineEvent(t, routine.state.id, event => event.type === "routine.delivery-attempted" && event.payload["entryId"] === entryId && event.payload["result"] === "delivered");
  expect(verifyStandardWebhook(SECRET, receiver.received.at(-1)!, t.clock.now())).toBe(true);
  await client.apply("attention.routes.set", { commandId: randomUUID(), target });
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toEqual({ id: target.id, endpoint: { name: "attention", state: "removed", secretKind: "pasted" } });
  expect((await client.request("routines.endpoints.list", {})).endpoints).toEqual([]);
});

it.each(["global", "other-client"])("keeps an endpoint used by a disabled %s route, then deletes it after the last global route", async owner => {
  const { t, client } = await start();
  const other = owner === "global" ? client : await t.client({ token: (await t.pair({ kind: "web", scopes: ["read"] })).token });
  const shared = { ...target, id: "shared-fallback", enabled: false };
  await other.apply(owner === "global" ? "attention.routes.set" : "attention.targets.set", { commandId: randomUUID(), target: shared });
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toEqual({ id: target.id, endpoint: { name: "attention", state: "retained" } });
  expect((await client.request("routines.endpoints.list", {})).endpoints).toMatchObject([{ name: "attention" }]);
  expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).toContain(SECRET);
  if (owner === "global") {
    expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: shared.id })).toEqual({ id: shared.id, endpoint: { name: "attention", state: "removed", secretKind: "pasted" } });
    expect((await client.request("routines.endpoints.list", {})).endpoints).toEqual([]);
  }
});

it("removes a route whose endpoint is already missing without claiming to delete a secret", async () => {
  const { client } = await start();
  await client.apply("routines.endpoints.remove", { commandId: randomUUID(), name: "attention" });
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toEqual({ id: target.id, endpoint: { name: "attention", state: "missing" } });
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toEqual({ id: target.id });
});

it("a reader cannot remove a global route or its endpoint and secret", async () => {
  const { t, client } = await start();
  const reader = await t.client({ token: (await t.pair({ kind: "web", scopes: ["read"] })).token });
  expect(await reader.call("attention.routes.remove", { commandId: randomUUID(), id: target.id })).toMatchObject({ error: { code: "forbidden" } });
  expect(await reader.request("attention.targets.remove", { commandId: randomUUID(), id: target.id })).toMatchObject({ receipt: { reason: "forbidden" } });
  expect((await client.request("routines.endpoints.list", {})).endpoints).toMatchObject([{ name: "attention" }]);
  expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).toContain(SECRET);
});


it("a route for an endpoint with no credential reports no signing secret removed", async () => {
  const { client } = await start();
  await client.apply("routines.endpoints.set", { commandId: randomUUID(), name: "without-secret", url: "https://receiver.example/attention" });
  await client.apply("attention.routes.set", { commandId: randomUUID(), target: { ...target, id: "without-secret", configuration: { endpoint: "without-secret" } } });
  expect(await client.apply("attention.routes.remove", { commandId: randomUUID(), id: "without-secret" })).toEqual({ id: "without-secret", endpoint: { name: "without-secret", state: "removed", secretKind: "missing" } });
});
