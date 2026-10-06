import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ask, fakeAdapter } from "../../test/fake-adapter.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { untilEvent } from "../../test/routines.js";
import { create } from "../../test/sessions.js";
import { attentionStream } from "./store.js";
import { registerAttentionTransport } from "../web/attention.js";

const { onCleanup, tempDir } = useCleanups();
const target = { id: "phone-target", label: "Chrome on Android, enabled 6 Oct, 13:04", transport: "push", enabled: true, completion: false, configuration: { endpoint: "opaque-test-endpoint" } } as const;

it("a disconnected read client owns its target, cannot change another's or a global route, and revocation erases it", async () => {
  const delivered: string[] = [];
  let deliveredOnce!: () => void;
  const delivery = new Promise<void>(resolve => { deliveredOnce = resolve; });
  onCleanup(registerAttentionTransport("push", () => ({ validate: () => undefined, send: async d => { expect(d.target.configuration).toEqual(target.configuration); delivered.push(d.id); deliveredOnce(); return { status: "sent" }; } })));
  const t = await startTestEnvironment({ webOrigin: "https://example.test:8443", adapter: fakeAdapter({ script: ask("question", {
    toolName: "AskUserQuestion", input: { secret: "private-prompt-for-tests" }, summary: "private-prompt-for-tests", questions: [{ header: "Choice", question: "Continue?", options: [], multiSelect: false }],
  }, { promptId: "attention-ask" }) }) });
  onCleanup(() => t.close());
  const phone = await t.pair({ kind: "web", scopes: ["read"], ceiling: "acceptEdits" });
  const phoneClient = await t.client({ token: phone.token });
  const other = await t.client({ token: (await t.pair({ kind: "web", scopes: ["read"] })).token });
  expect((await phoneClient.apply("attention.targets.set", { commandId: randomUUID(), target })).id).toBe(target.id);
  expect((await other.request("attention.targets.list", {})).targets).toEqual([]);
  expect((await other.request("attention.targets.set", { commandId: randomUUID(), target })).receipt).toMatchObject({ reason: "forbidden" });
  expect((await other.request("attention.targets.remove", { commandId: randomUUID(), id: target.id })).receipt).toMatchObject({ reason: "forbidden" });
  expect(await other.call("attention.routes.set", { commandId: randomUUID(), target })).toMatchObject({ error: { code: "forbidden" } });
  await phoneClient.apply("attention.targets.configure", { commandId: randomUUID(), id: target.id, enabled: false, completion: true });
  expect((await phoneClient.request("attention.targets.list", {})).targets[0]).toMatchObject({ state: "disabled", completion: true });
  await phoneClient.apply("attention.targets.configure", { commandId: randomUUID(), id: target.id, enabled: true, completion: false });
  const admin = await t.client();
  const { id } = await create(admin);
  await admin.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Ask one question" });
  await untilEvent(t, { kind: "session", id }, e => e.type === "prompt.opened");
  await Promise.all([phoneClient.close(), other.close(), admin.close()]);
  t.clock.advance(5999);
  expect(delivered).toEqual([]);
  t.clock.advance(1);
  await delivery;
  expect(delivered).toHaveLength(1);
  const fresh = await t.client({ token: phone.token });
  expect((await fresh.request("attention.targets.list", {})).targets).toEqual([{ id: target.id, label: target.label, transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null }]);
  t.env.clientSessions.revoke(phone.clientSessionId);
  const operator = await t.client();
  expect((await operator.request("attention.targets.list", {})).targets).toEqual([]);
});


it("retries the same pending delivery after a real environment restart and cancels it when another client answers", async () => {
  const attempts: string[] = [];
  onCleanup(registerAttentionTransport("push", () => ({ validate: () => undefined, send: async d => { attempts.push(d.id); return { status: "retry" }; } })));
  const dataDir = tempDir();
  const first = await startTestEnvironment({ dataDir, webOrigin: "https://example.test:8443", adapter: fakeAdapter({ script: ask("question", {
    questions: [{ header: "Choice", question: "Continue?", options: [], multiSelect: false }],
  }, { promptId: "restart-ask" }) }) });
  onCleanup(() => first.close());
  const phone = await first.pair({ kind: "web", scopes: ["read"] });
  const owner = await first.client({ token: phone.token });
  await owner.apply("attention.targets.set", { commandId: randomUUID(), target });
  const driver = await first.client();
  const { id } = await create(driver);
  await driver.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Ask one question" });
  await untilEvent(first, { kind: "session", id }, e => e.type === "prompt.opened");
  await Promise.all([owner.close(), driver.close()]);
  first.clock.advance(6000);
  await untilEvent(first, attentionStream, e => e.type === "attention.delivery.result");
  expect(attempts).toHaveLength(1);
  await first.close();
  const again = await startTestEnvironment({ dataDir, clock: first.clock, webOrigin: "https://example.test:8443" });
  onCleanup(() => again.close());
  const beforeRetry = again.env.log.head();
  again.clock.advance(60_000);
  await untilEvent(again, attentionStream, e => e.sequence > beforeRetry && e.type === "attention.delivery.result");
  expect(attempts).toEqual([attempts[0], attempts[0]]);
  const answerer = await again.client();
  await answerer.apply("permissions.prompts.answer", { commandId: randomUUID(), promptId: "restart-ask", decision: "deny" });
  again.clock.advance(5 * 60_000);
  await answerer.request("permissions.prompts.list", {});
  expect(attempts).toHaveLength(2);
});

it("a target's readable label is listed and survives a preference change", async () => {
  onCleanup(registerAttentionTransport("push", () => ({ validate: () => undefined, send: async () => ({ status: "sent" }) })));
  const t = await startTestEnvironment({ webOrigin: "https://example.test:8443" });
  onCleanup(() => t.close());
  const phone = await t.client({ token: (await t.pair({ kind: "web", scopes: ["read"] })).token });
  onCleanup(() => phone.close());
  await phone.apply("attention.targets.set", { commandId: randomUUID(), target });
  await phone.apply("attention.targets.configure", { commandId: randomUUID(), id: target.id, enabled: true, completion: true });
  expect((await phone.request("attention.targets.list", {})).targets).toEqual([expect.objectContaining({ id: target.id, label: target.label, completion: true })]);
});
