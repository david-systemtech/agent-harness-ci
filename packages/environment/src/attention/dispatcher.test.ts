import { join } from "node:path";
import { expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { openEventLog } from "../event-log/event-log.js";
import { attentionStream } from "./store.js";
import { createAttentionDispatcher } from "./dispatcher.js";
import type { AttentionTransport } from "./targets.js";

const { tempDir, onCleanup } = useCleanups();
const parked = { kind: "session", id: "session-1" } as const;
const target = { id: "target-1", transport: "push", enabled: true, completion: false, configuration: { endpoint: "opaque-test-endpoint" } } as const;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

it("enqueues once, keeps the ID across restart, and sends only generic text after six seconds", async () => {
  const clock = manualClock();
  const path = join(tempDir(), "events.db");
  let log = openEventLog({ path, clock: clock.now });
  const sent: string[] = [];
  const payloads: unknown[] = [];
  const transport: AttentionTransport = { validate: () => undefined, send: async delivery => { sent.push(delivery.id); payloads.push(delivery.payload); return { status: "sent" }; } };
  let dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test:8443", transports: { push: transport } });
  log.append(attentionStream, [{ type: "attention.target.set", payload: { target, owner: null } }], { actor: "system:attention" });
  log.append(parked, [{ type: "prompt.opened", payload: { promptId: "prompt-1", ttlExpiresAt: null } }], { actor: "system:permissions" });
  const pending = dispatcher.store.deliveries();
  expect(pending).toHaveLength(1);
  clock.advance(5999);
  await dispatcher.flush();
  expect(sent).toEqual([]);
  dispatcher.close(); log.close();
  log = openEventLog({ path, clock: clock.now });
  dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test:8443", transports: { push: transport } });
  onCleanup(() => { dispatcher.close(); log.close(); });
  expect(dispatcher.store.deliveries()[0]?.id).toBe(pending[0]?.id);
  clock.advance(1);
  await dispatcher.flush();
  expect(sent).toEqual([pending[0]?.id]);
  expect(payloads).toEqual([{ message: "A session needs you", url: "https://example.test:8443/#/session/env-1/session-1" }]);
  clock.advance(60_000);
  await dispatcher.flush();
  expect(sent).toHaveLength(1);
});

it("cancels answers, TTL expiry and removed targets before retry, without leaking a failing transport's exception", async () => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: clock.now });
  const sent: string[] = [];
  const dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => { sent.push(d.target.id); throw new Error("secret-for-tests"); } },
    webhook: { validate: () => undefined, send: async d => { sent.push(d.target.id); return { status: "sent" }; } },
  } });
  onCleanup(() => { dispatcher.close(); log.close(); });
  const append = (type: string, payload: Record<string, unknown>) => log.append(parked, [{ type, payload }], { actor: "system:permissions" });
  log.append(attentionStream, [
    { type: "attention.target.set", payload: { target, owner: null } },
    { type: "attention.target.set", payload: { target: { ...target, id: "healthy", transport: "webhook" }, owner: null } },
  ], { actor: "system:attention" });
  append("prompt.opened", { promptId: "answered", ttlExpiresAt: null });
  append("prompt.answered", { promptId: "answered" });
  append("prompt.opened", { promptId: "expired", ttlExpiresAt: new Date(clock.now().getTime() + 5000).toISOString() });
  clock.advance(6000);
  await dispatcher.flush();
  expect(sent).toEqual([]);
  append("prompt.opened", { promptId: "waiting", ttlExpiresAt: null });
  clock.advance(6000);
  await dispatcher.flush();
  expect(sent.sort()).toEqual(["healthy", "target-1"]);
  expect(dispatcher.store.status(() => true)).toContainEqual({ id: target.id, transport: target.transport, enabled: true, completion: false, global: true, owner: null, state: "failed", failure: "Delivery failed. Check the configured transport." });
  const id = dispatcher.store.deliveries().find(d => d.targetId === "target-1" && d.state === "pending")?.id;
  expect(id).toBeDefined();
  append("prompt.answered", { promptId: "waiting" });
  clock.advance(60_000);
  await dispatcher.flush();
  expect(sent).toHaveLength(2);
  expect(dispatcher.store.deliveries().find(d => d.id === id)?.state).toBe("cancelled");
});

it("removes targets owned by a revoked or expired client", async () => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: clock.now });
  log.atomically(tx => log.clientSessions.insert(tx, { id: "client-1", kind: "web", label: "Phone", scopes: ["read"], ceiling: "acceptEdits", local: false,
    createdAt: clock.now().toISOString(), lastSeenAt: null, expiresAt: new Date(clock.now().getTime() + 10_000).toISOString(), revokedAt: null }, []));
  const dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {} });
  onCleanup(() => { dispatcher.close(); log.close(); });
  log.append(attentionStream, [{ type: "attention.target.set", payload: { target, owner: "client-1" } }], { actor: "system:attention" });
  expect(dispatcher.store.targets()).toHaveLength(1);
  clock.advance(10_000);
  await dispatcher.flush();
  expect(dispatcher.store.targets()).toEqual([]);
});

it("keeps routine completions opt-in and suppresses silent outcomes", async () => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: clock.now });
  const sent: string[] = [];
  const dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => { sent.push(d.target.id); return { status: "sent" }; } },
  } });
  onCleanup(() => { dispatcher.close(); log.close(); });
  log.append(attentionStream, [
    { type: "attention.target.set", payload: { target, owner: null } },
    { type: "attention.target.set", payload: { target: { ...target, id: "opted-in", completion: true }, owner: null } },
  ], { actor: "system:attention" });
  const routine = { kind: "routine", id: "routine-1" };
  log.append(routine, [
    { type: "routine.firing-started", payload: { firingId: "silent", sessionId: "session-1" } },
    { type: "routine.firing-ended", payload: { firingId: "silent", outcome: "silent", text: "private text" } },
    { type: "routine.firing-started", payload: { firingId: "successful", sessionId: "session-2" } },
    { type: "routine.firing-ended", payload: { firingId: "successful", outcome: "succeeded", text: "private result" } },
  ], { actor: "system:routines" });
  clock.advance(6000);
  await dispatcher.flush();
  expect(sent).toEqual(["opted-in"]);
});

it.each(["queued", "in-flight"])("withdraws completion delivery consent while %s, keeping parked asks eligible", async stage => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: clock.now });
  const started = deferred<AbortSignal>();
  const response = deferred<{ status: "sent" }>();
  const sent: string[] = [];
  const dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => {
      sent.push(d.id);
      if (sent.length === 1 && stage === "in-flight") { started.resolve(d.signal); return response.promise; }
      return { status: "sent" };
    } },
  } });
  onCleanup(() => { response.resolve({ status: "sent" }); dispatcher.close(); log.close(); });
  const set = (completion: boolean) => log.append(attentionStream, [{ type: "attention.target.set", payload: { target: { ...target, completion }, owner: null } }], { actor: "system:attention" });
  set(true);
  log.append({ kind: "routine", id: "routine-1" }, [
    { type: "routine.firing-started", payload: { firingId: "done", sessionId: "session-1" } },
    { type: "routine.firing-ended", payload: { firingId: "done", outcome: "succeeded" } },
  ], { actor: "system:routines" });
  if (stage === "in-flight") { clock.advance(6000); await started.promise; }
  set(false);
  if (stage === "in-flight") {
    expect((await started.promise).aborted).toBe(true);
    response.resolve({ status: "sent" });
  }
  clock.advance(6000);
  await dispatcher.flush();
  expect(dispatcher.store.deliveries()[0]?.state).toBe("cancelled");
  expect(sent).toHaveLength(stage === "queued" ? 0 : 1);
  log.append(parked, [{ type: "prompt.opened", payload: { promptId: "still-waiting", ttlExpiresAt: null } }], { actor: "system:permissions" });
  clock.advance(6000);
  await dispatcher.flush();
  expect(dispatcher.store.deliveries().find(d => d.promptId === "still-waiting")?.state).toBe("sent");
});

it("does not begin sending an ask answered between timer admission and transport execution", async () => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: clock.now });
  const sent: string[] = [];
  const dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => { sent.push(d.id); return { status: "sent" }; } },
  } });
  onCleanup(() => { dispatcher.close(); log.close(); });
  log.append(attentionStream, [{ type: "attention.target.set", payload: { target, owner: null } }], { actor: "system:attention" });
  log.append(parked, [{ type: "prompt.opened", payload: { promptId: "race", ttlExpiresAt: null } }], { actor: "system:permissions" });
  clock.advance(6000);
  log.append(parked, [{ type: "prompt.answered", payload: { promptId: "race" } }], { actor: "system:permissions" });
  await dispatcher.flush();
  expect(sent).toEqual([]);
});

it.each(["sent", "retry", "retire"] as const)("ignores an old registration's %s response after endpoint replacement", async status => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: clock.now });
  const started = deferred<AbortSignal>();
  const response = deferred<{ status: typeof status }>();
  const endpoints: string[] = [];
  const ids: string[] = [];
  const dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => {
      endpoints.push(d.target.configuration["endpoint"]!); ids.push(d.id);
      if (endpoints.length === 1) { started.resolve(d.signal); return response.promise; }
      return { status: "sent" };
    } },
  } });
  onCleanup(() => { response.resolve({ status }); dispatcher.close(); log.close(); });
  log.append(attentionStream, [{ type: "attention.target.set", payload: { target, owner: null } }], { actor: "system:attention" });
  log.append(parked, [{ type: "prompt.opened", payload: { promptId: "replacement", ttlExpiresAt: null } }], { actor: "system:permissions" });
  clock.advance(6000);
  const finishing = dispatcher.flush();
  const signal = await started.promise;
  log.append(attentionStream, [{ type: "attention.target.set", payload: { target: { ...target, configuration: { endpoint: "replacement-test-endpoint" } }, owner: null } }], { actor: "system:attention" });
  const aborted = signal.aborted;
  response.resolve({ status });
  await finishing;
  expect(aborted).toBe(true);
  expect(dispatcher.store.targets()[0]?.target.configuration).toEqual({ endpoint: "replacement-test-endpoint" });
  expect(dispatcher.store.deliveries()[0]).toMatchObject({ state: "pending", attempts: 0 });
  expect(dispatcher.store.status(() => true)[0]?.failure).toBeNull();
  await dispatcher.flush();
  expect(endpoints).toEqual(["opaque-test-endpoint", "replacement-test-endpoint"]);
  expect(ids[1]).toBe(ids[0]);
  expect(dispatcher.store.deliveries()[0]).toMatchObject({ state: "sent", attempts: 1 });
});

it("retries a failure after restart with the same ID and cancels an offline answer", async () => {
  const clock = manualClock();
  const path = join(tempDir(), "retry.db");
  let log = openEventLog({ path, clock: clock.now });
  const sent: string[] = [];
  let dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => { sent.push(d.id); return { status: "retry" }; } },
  } });
  log.append(attentionStream, [{ type: "attention.target.set", payload: { target, owner: null } }], { actor: "system:attention" });
  log.append(parked, [{ type: "prompt.opened", payload: { promptId: "retry", ttlExpiresAt: null } }], { actor: "system:permissions" });
  clock.advance(6000);
  await dispatcher.flush();
  dispatcher.close(); log.close();
  log = openEventLog({ path, clock: clock.now });
  dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => { sent.push(d.id); return { status: "retry" }; } },
  } });
  clock.advance(60_000);
  await dispatcher.flush();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  dispatcher.close();
  log.append(parked, [{ type: "prompt.answered", payload: { promptId: "retry" } }], { actor: "system:permissions" });
  log.close();
  log = openEventLog({ path, clock: clock.now });
  dispatcher = createAttentionDispatcher({ log, clock, environmentId: "env-1", webOrigin: () => "https://example.test", transports: {
    push: { validate: () => undefined, send: async d => { sent.push(d.id); return { status: "sent" }; } },
  } });
  onCleanup(() => { dispatcher.close(); log.close(); });
  clock.advance(5 * 60_000);
  await dispatcher.flush();
  expect(sent).toHaveLength(2);
});
