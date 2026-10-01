import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ENVIRONMENT_STREAM_KIND, WebhookPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";
import { manualClock } from "../../test/clock.js";
import { end } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, ranNow, listed, routineCommand, routineUpdates, untilEvent, untilRoutineEvent, untilSettled, written } from "../../test/routines.js";
import { closedOrigin, verifyStandardWebhook, webhookReceiver } from "../../test/webhook-receiver.js";

const { onCleanup, tempDir } = useCleanups();
const secret = "token-for-tests";
const setup = async (options: TestEnvironmentOptions = {}) => {
  const receiver = await webhookReceiver();
  onCleanup(() => receiver.close());
  const t = await startTestEnvironment({ name: "laptop", ...options });
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: `${receiver.origin}/webhooks/harness`, secret: { kind: "pasted", secret } });
  const routine = await created(client, written({ schedule: { kind: "manual" }, delivery: [{ kind: "webhook", target: "hermes", on: "both" }] }));
  const fire = async (text = "Digest filed.") => {
    t.adapter.nextScripts.push(() => [end("completed", { resultText: text })]);
    return ranNow(client, routine.state.id);
  };
  const attempted = (attempt: number, entryId?: string) => untilRoutineEvent(t, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["attempt"] === attempt && (entryId === undefined || e.payload["entryId"] === entryId));
  return { t, client, receiver, routine, fire, attempted };
};

describe("signed result delivery", () => {
  it("posts the firing's full result with a verified Standard Webhooks signature and records the delivery in history", async () => {
    const { t, client, receiver, routine, fire, attempted } = await setup();
    const entryId = await fire("Digest filed.\n" + "x".repeat(17000));
    await attempted(1);
    const [entry] = await history(client, routine.state.id);
    if (entry?.kind !== "firing") throw new Error("No firing in history");
    const request = receiver.received[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/webhooks/harness");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(verifyStandardWebhook(secret, request, t.clock.now())).toBe(true);
    expect(WebhookPayload.parse(JSON.parse(request.body))).toEqual({
      type: "routine.result", version: 1,
      environment: { id: t.env.id, name: "laptop" }, routine: { id: routine.state.id, name: "Upstream watch" },
      entry: { id: entryId, kind: "firing", trigger: "run-now", dueAt: entry.dueAt, startedAt: entry.startedAt, endedAt: entry.endedAt, outcome: "succeeded", reason: null, sessionId: entry.sessionId },
      summary: "Digest filed.", text: ("Digest filed.\n" + "x".repeat(17000)).slice(0, 16000),
    });
    expect(entry.deliveries).toEqual([{ target: { kind: "webhook", target: "hermes", on: "both" }, result: "delivered", attempts: [{ attempt: 1, at: t.clock.now().toISOString(), result: "delivered", status: 204, error: null, retryAt: null }] }]);
    expect(t.env.log.readStream({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id }).filter((e) => e.type === "routine.delivery-failed")).toEqual([]);
  });
  it("retries a 503 after one minute with the same id, refreshed signature and no routine.updated", async () => {
    const { t, client, receiver, routine, fire, attempted } = await setup();
    receiver.answer({ status: 503 });
    const entryId = await fire();
    expect((await attempted(1)).payload).toMatchObject({ result: "retrying", status: 503, retryAt: "2026-09-24T00:01:00.000Z" });
    const head = t.env.log.head();
    receiver.answer({ status: 200 });
    t.clock.advance(59_999);
    expect(receiver.received).toHaveLength(1);
    t.clock.advance(1);
    expect((await attempted(2)).payload).toMatchObject({ result: "delivered", status: 200, retryAt: null });
    expect(receiver.received.map((r) => r.headers["webhook-id"])).toEqual([`${entryId}:hermes:both`, `${entryId}:hermes:both`]);
    expect(verifyStandardWebhook(secret, receiver.received[1]!, t.clock.now())).toBe(true);
    expect(receiver.received[1]!.headers["webhook-timestamp"]).not.toBe(receiver.received[0]!.headers["webhook-timestamp"]);
    expect(await routineUpdates(client, head)).toEqual([]);
    expect((await history(client, routine.state.id))[0]?.deliveries[0]?.attempts.map((a) => a.result)).toEqual(["retrying", "delivered"]);
  });

  it("shows missing endpoints, missing secrets and a final failed delivery as attention, clearing the last when a later result delivers", async () => {
    const { client, receiver, routine, fire, attempted } = await setup();
    await client.request("routines.endpoints.remove", { commandId: randomUUID(), name: "hermes" });
    expect((await listed(client, routine.state.id))?.attention).toContain("endpoint_missing");
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: receiver.origin });
    expect((await listed(client, routine.state.id))?.attention).toContain("endpoint_needs_secret");
    const entryId = await fire();
    expect((await attempted(1, entryId)).payload).toMatchObject({ result: "failed", status: null, retryAt: null });
    expect((await listed(client, routine.state.id))?.attention).toContain("delivery_failing");
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: receiver.origin, secret: { kind: "pasted", secret } });
    const nextId = await fire();
    await attempted(1, nextId);
    expect((await listed(client, routine.state.id))?.attention.filter((code) => ["endpoint_missing", "endpoint_needs_secret", "delivery_failing"].includes(code))).toEqual([]);
  });
  it("records a failing skip's detail, time, reason and null session in its signed payload", async () => {
    const { t, client, receiver, routine, attempted } = await setup();
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { model: "model-not-offered" } });
    const entryId = await ranNow(client, routine.state.id);
    await attempted(1);
    const [entry] = await history(client, routine.state.id);
    if (entry?.kind !== "skip") throw new Error("No skip in history");
    expect(WebhookPayload.parse(JSON.parse(receiver.received[0]!.body))).toMatchObject({
      entry: { id: entryId, kind: "skip", trigger: "run-now", dueAt: entry.dueAt, startedAt: entry.at, endedAt: entry.at, outcome: "failed", reason: "cannot-start", sessionId: null },
      text: entry.detail,
    });
    expect(verifyStandardWebhook(secret, receiver.received[0]!, t.clock.now())).toBe(true);
  });

  it.each([408, 429, 500, 503])("retries %i after 1, 5 and 30 minutes then tells every client of the final failure", async (status) => {
    const { t, client, receiver, routine, fire, attempted } = await setup();
    const other = await t.client();
    const subscriptions = await Promise.all([client, other].map(async (wire) => {
      const { subscription } = await wire.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
      await wire.next((f) => "subscription" in f && f.subscription === subscription && f.type === "synchronized");
      return subscription;
    }));
    receiver.answer({ status });
    const entryId = await fire();
    await attempted(1);
    for (const [index, delay] of [60_000, 300_000, 1_800_000].entries()) {
      t.clock.advance(delay - 1);
      expect(receiver.received).toHaveLength(index + 1);
      t.clock.advance(1);
      expect((await attempted(index + 2)).payload).toMatchObject({ attempt: index + 2, result: index === 2 ? "failed" : "retrying", status });
    }
    for (const [index, wire] of [client, other].entries()) {
      const frame = await wire.next((f) => "subscription" in f && f.subscription === subscriptions[index] && f.type === "event" && f.event.type === "routine.delivery-failed");
      expect(frame).toMatchObject({ event: { payload: { routineId: routine.state.id, name: "Upstream watch", entryId, endpoint: "hermes", error: `The endpoint answered ${status}.` } } });
    }
    expect((await history(client, routine.state.id))[0]?.deliveries[0]?.attempts).toHaveLength(4);
    t.clock.advance(1_800_000);
    expect(receiver.received).toHaveLength(4);
  });

  it.each([400, 302])("fails %i at once and follows no redirect", async (status) => {
    const { t, client, receiver, routine, fire, attempted } = await setup();
    const redirected = await webhookReceiver();
    onCleanup(() => redirected.close());
    receiver.answer({ status, headers: { location: redirected.origin } });
    await fire();
    expect((await attempted(1)).payload).toMatchObject({ result: "failed", status, retryAt: null });
    await untilEvent(t, { kind: ENVIRONMENT_STREAM_KIND, id: t.env.id }, (e) => e.type === "routine.delivery-failed");
    t.clock.advance(60_000);
    expect(receiver.received).toHaveLength(1);
    expect(redirected.received).toEqual([]);
    expect((await history(client, routine.state.id))[0]?.deliveries[0]?.result).toBe("failed");
  });

  it("retries a network error and resolves the endpoint again on the retry", async () => {
    const { t, client, receiver, fire, attempted } = await setup();
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: await closedOrigin() });
    await fire();
    expect((await attempted(1)).payload).toMatchObject({ result: "retrying", status: null, error: expect.stringContaining("could not be reached") });
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: receiver.origin });
    t.clock.advance(60_000);
    expect((await attempted(2)).payload).toMatchObject({ result: "delivered" });
    expect(receiver.received).toHaveLength(1);
  });

  it("times a hanging receiver out after ten seconds while another firing can finish", async () => {
    const { t, client, receiver, routine, fire, attempted } = await setup();
    receiver.answer("hang");
    const received = receiver.next();
    const first = await fire();
    await received;
    await untilSettled(t, routine.state.id, first);
    const next = receiver.next();
    const second = await fire();
    await next;
    await untilSettled(t, routine.state.id, second);
    expect((await history(client, routine.state.id)).map((e) => e.kind === "firing" ? e.outcome : null)).toEqual(["succeeded", "succeeded"]);
    t.clock.advance(9999);
    expect((await history(client, routine.state.id))[0]?.deliveries).toEqual([]);
    t.clock.advance(1);
    expect((await attempted(1, first)).payload).toMatchObject({ result: "retrying", status: null, error: "The endpoint did not answer within 10 seconds.", retryAt: "2026-09-24T00:01:10.000Z" });
    await attempted(1, second);
  });

  it.each([false, true])("resumes a retry on the same data directory at retryAt or immediately if overdue (%s)", async (overdue) => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { t, client, receiver, routine, fire, attempted } = await setup({ dataDir });
    receiver.answer({ status: 503 });
    await fire();
    await attempted(1);
    const firstId = receiver.received[0]!.headers["webhook-id"];
    await client.close();
    await t.close();
    receiver.answer({ status: 200 });
    const clock = manualClock(overdue ? "2026-09-24T00:02:00.000Z" : "2026-09-24T00:00:30.000Z");
    const restarted = await startTestEnvironment({ dataDir, clock });
    onCleanup(() => restarted.close());
    if (!overdue) {
      clock.advance(29_999);
      expect(receiver.received).toHaveLength(1);
      clock.advance(1);
    }
    await untilRoutineEvent(restarted, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["attempt"] === 2);
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[1]!.headers["webhook-id"]).toBe(firstId);
    expect(verifyStandardWebhook(secret, receiver.received[1]!, clock.now())).toBe(true);
    const newClient = await restarted.client();
    expect((await history(newClient, routine.state.id))[0]?.deliveries[0]?.attempts.map((a) => a.result)).toEqual(["retrying", "delivered"]);
  });

  it("fails a missing endpoint at once without posting", async () => {
    const { t, client, receiver, fire, attempted } = await setup();
    await client.request("routines.endpoints.remove", { commandId: randomUUID(), name: "hermes" });
    await fire();
    expect((await attempted(1)).payload).toMatchObject({ result: "failed", status: null, error: "No webhook endpoint hermes is on this environment.", retryAt: null });
    t.clock.advance(60_000);
    expect(receiver.received).toEqual([]);
  });

  it("cancels an in-flight POST at shutdown and recovers the owed delivery with the same id", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { t, receiver, routine, fire } = await setup({ dataDir });
    receiver.answer("hang");
    const received = receiver.next();
    await fire();
    const request = await received;
    await t.close();
    receiver.answer({ status: 200 });
    const restarted = await startTestEnvironment({ dataDir });
    onCleanup(() => restarted.close());
    await untilRoutineEvent(restarted, routine.state.id, (e) => e.type === "routine.delivery-attempted");
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[1]!.headers["webhook-id"]).toBe(request.headers["webhook-id"]);
    const client = await restarted.client();
    expect((await history(client, routine.state.id))[0]?.deliveries[0]?.attempts).toHaveLength(1);
    await restarted.close();
    const again = await startTestEnvironment({ dataDir });
    onCleanup(() => again.close());
    // The start pass is synchronous and discovers no owed target after a delivered attempt.
    await (await again.client()).request("routines.list", {});
    expect(receiver.received).toHaveLength(2);
  });

  it("delivers every distinct target once, preserving target order in history", async () => {
    const { t, client, routine, fire } = await setup();
    const other = await webhookReceiver();
    onCleanup(() => other.close());
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "matrix", url: other.origin, secret: { kind: "pasted", secret } });
    const targets = [{ kind: "webhook" as const, target: "matrix", on: "success" as const }, { kind: "webhook" as const, target: "hermes", on: "both" as const }];
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [...targets, targets[0]!] } });
    const entryId = await fire();
    for (const target of targets) {
      await untilRoutineEvent(t, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId && (e.payload["target"] as { target: string }).target === target.target);
    }
    expect((await history(client, routine.state.id))[0]?.deliveries.map((delivery) => delivery.target)).toEqual(targets);
    expect(other.received).toHaveLength(1);
  });

  it("retries an unavailable secret store and scrubs its error before the attempt reaches a client", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const held = fileVault(join(dataDir, VAULT_FILE));
    let unavailable = false;
    const vault = { ...held, get: async (key: string) => {
      if (unavailable && key === "endpoint:hermes") throw new Error(`The store could not read ${secret}`);
      return held.get(key);
    } };
    const { t, receiver, fire, attempted } = await setup({ dataDir, vault });
    unavailable = true;
    await fire();
    expect((await attempted(1)).payload).toMatchObject({ result: "retrying", status: null, error: "The endpoint's secret could not be resolved: The store could not read [redacted]." });
    expect(receiver.received).toEqual([]);
    unavailable = false;
    t.clock.advance(60_000);
    expect((await attempted(2)).payload).toMatchObject({ result: "delivered" });
    expect(verifyStandardWebhook(secret, receiver.received[0]!, t.clock.now())).toBe(true);
  });

});
