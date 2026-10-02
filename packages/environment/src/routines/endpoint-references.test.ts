import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { end } from "../../test/fake-adapter.js";
import { created, history, ranNow, untilRoutineEvent, written } from "../../test/routines.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, move, moveList, setBasePath, signOut } from "../../test/key-manager-connections.js";
import { verifyStandardWebhook, webhookReceiver } from "../../test/webhook-receiver.js";

/** Endpoint references through the in-process environment, fake OpenBao and an independent webhook verifier (#536). */
const { onCleanup } = useCleanups();
const SECRET = "endpoint-secret-for-tests";
const ROTATED = "rotated-endpoint-secret-for-tests";

const setup = async (options: TestEnvironmentOptions = {}) => {
  const receiver = await webhookReceiver();
  onCleanup(() => receiver.close());
  const t = await startTestEnvironment({ name: "laptop", ...options });
  onCleanup(() => t.close());
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "endpoints"] });
  bao.policy("endpoints", 'path "personal/data/harness/*" { capabilities = ["create", "update", "read"] }');
  bao.kv("personal", 2);
  const client = await t.client();
  const connection = await added(client, { label: "Personal OpenBao", address: bao.address, ca: bao.ca, credential: approle() });
  const reference = { provider: "openbao" as const, connectionId: connection.id, mount: "personal", path: "harness/endpoint-hermes", key: "secret" };
  const set = () => client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: `${receiver.origin}/hook`, secret: { kind: "reference", reference } });
  const test = () => client.request("routines.endpoints.test", { name: "hermes" });
  return { t, client, bao, receiver, connection, reference, set, test };
};

describe("endpoint secret references", () => {
  it("resolves each test afresh, signs with the current value and scrubs it only while the POST runs", async () => {
    const { t, client, bao, receiver, set, test } = await setup();
    bao.secret("personal", "harness/endpoint-hermes", { secret: SECRET });
    await set();
    expect((await client.request("routines.endpoints.list", {})).endpoints).toMatchObject([
      { secretKind: "reference", reference: { provider: "openbao", label: "Personal OpenBao", locator: "personal/harness/endpoint-hermes (key secret)" } },
    ]);
    expect(await test()).toMatchObject({ status: 204, error: null });
    expect(verifyStandardWebhook(SECRET, receiver.received[0]!, t.clock.now())).toBe(true);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
    const received = receiver.next();
    receiver.answer("hang");
    const pending = test();
    const first = await received;
    expect(verifyStandardWebhook(SECRET, first, t.clock.now())).toBe(true);
    expect(t.scrub.scrub(SECRET)).toBe("[redacted]");
    t.clock.advance(10_000);
    expect(await pending).toMatchObject({ status: null, error: expect.stringContaining("did not answer") });
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);

    bao.secret("personal", "harness/endpoint-hermes", { secret: ROTATED });
    receiver.answer({ status: 204 });
    expect(await test()).toMatchObject({ status: 204, error: null });
    expect(verifyStandardWebhook(ROTATED, receiver.received[2]!, t.clock.now())).toBe(true);
    expect(verifyStandardWebhook(SECRET, receiver.received[2]!, t.clock.now())).toBe(false);
    expect(t.scrub.scrub(ROTATED)).toBe(ROTATED);
  });
  it("moves a pasted endpoint to <base>/endpoint-<name>, deletes its vault entry and signs successive deliveries with the live rotated value", async () => {
    const { t, client, bao, receiver, connection, reference } = await setup();
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: `${receiver.origin}/hook`, secret: { kind: "pasted", secret: SECRET } });
    await setBasePath(client, connection.id, "personal/harness");
    expect(await moveList(client)).toMatchObject([
      { kind: "endpoint", id: "hermes", name: "hermes", targets: [{ connectionId: connection.id, reference }] },
    ]);
    const answer = await move(client, { connectionId: connection.id, items: [{ kind: "endpoint", id: "hermes" }] });
    expect(answer.result?.items).toMatchObject([{ item: { kind: "endpoint", id: "hermes" }, outcome: "moved", reference, storedValueDeleted: true }]);
    expect(bao.stored("personal", "harness/endpoint-hermes")).toMatchObject({ secret: SECRET, service: `127.0.0.1:${new URL(receiver.origin).port}`, added: "2026-09-24" });
    expect(await fileVault(join(t.dataDir, VAULT_FILE)).get("endpoint:hermes")).toBeUndefined();
    expect(await moveList(client)).toEqual([]);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
    const routine = await created(client, written({ schedule: { kind: "manual" }, delivery: [{ kind: "webhook", target: "hermes", on: "both" }] }));
    const fire = async () => {
      t.adapter.nextScripts.push(() => [end("completed", { resultText: "Digest filed." })]);
      const entryId = await ranNow(client, routine.state.id);
      await untilRoutineEvent(t, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId);
    };
    await fire();
    expect(verifyStandardWebhook(SECRET, receiver.received[0]!, t.clock.now())).toBe(true);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
    bao.secret("personal", "harness/endpoint-hermes", { secret: ROTATED });
    await fire();
    expect(verifyStandardWebhook(ROTATED, receiver.received[1]!, t.clock.now())).toBe(true);
    expect(verifyStandardWebhook(SECRET, receiver.received[1]!, t.clock.now())).toBe(false);
    expect(t.scrub.scrub(ROTATED)).toBe(ROTATED);
  });

  it("refuses connection removal with the endpoint named as a holder, unless force is given", async () => {
    const { client, connection, set, test } = await setup();
    await set();
    const params: ParamsOf<"keyManagers.connections.remove"> = { commandId: randomUUID(), connectionId: connection.id };
    const refused = await client.request("keyManagers.connections.remove", params);
    expect(refused.receipt).toMatchObject({ status: "rejected", error: {
      code: "conflict", data: { reason: "referenced", holders: [{ kind: "endpoint", id: "hermes", name: "hermes" }] },
    } });
    const removed = await client.request("keyManagers.connections.remove", { ...params, commandId: randomUUID(), force: true });
    expect(removed.receipt.status).toBe("accepted");
    expect(await test()).toEqual({ status: null, durationMs: 0, error: "credential_source_unavailable" });
    expect((await client.request("routines.endpoints.list", {})).endpoints[0]?.reference?.label).toBeNull();
  });

  it.each(["credential_source_unavailable", "reference_not_found", "reference_denied"] as const)("reports %s immediately for tests and retries delivery with a fresh read", async (code) => {
    const { t, client, bao, receiver, connection, set, test } = await setup();
    await set();
    if (code === "credential_source_unavailable") await signOut(client, connection.id);
    if (code === "reference_denied") bao.policy("endpoints", 'path "personal/data/elsewhere/*" { capabilities = ["read"] }');
    expect(await test()).toEqual({ status: null, durationMs: 0, error: code });
    expect(receiver.received).toEqual([]);
    const routine = await created(client, written({ schedule: { kind: "manual" }, delivery: [{ kind: "webhook", target: "hermes", on: "both" }] }));
    t.adapter.nextScripts.push(() => [end("completed", { resultText: "Digest filed." })]);
    const entryId = await ranNow(client, routine.state.id);
    const attempted = (attempt: number) => untilRoutineEvent(t, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId && e.payload["attempt"] === attempt);
    await attempted(1);
    expect((await history(client, routine.state.id))[0]?.deliveries[0]).toMatchObject({ result: "pending", attempts: [{ attempt: 1, result: "retrying", status: null, error: code }] });
    expect(receiver.received).toEqual([]);
    t.clock.advance(60_000);
    await attempted(2);
    expect((await history(client, routine.state.id))[0]?.deliveries[0]?.attempts[1]).toMatchObject({ result: "retrying", error: code });
    if (code === "reference_not_found") {
      bao.secret("personal", "harness/endpoint-hermes", { secret: SECRET });
      t.clock.advance(300_000);
      await attempted(3);
      expect(verifyStandardWebhook(SECRET, receiver.received[0]!, t.clock.now())).toBe(true);
      expect(t.scrub.scrub(SECRET)).toBe(SECRET);
    } else {
      t.clock.advance(300_000);
      await attempted(3);
      t.clock.advance(1_800_000);
      await attempted(4);
      expect((await history(client, routine.state.id))[0]?.deliveries[0]).toMatchObject({ result: "failed", attempts: expect.arrayContaining([{ attempt: 4, at: expect.any(String), result: "failed", status: null, error: code, retryAt: null }]) });
    }
  });

  it("lets go of a pasted secret replaced directly by a reference, and forgets the reference when replaced by a paste", async () => {
    const { t, client, receiver, set } = await setup();
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: `${receiver.origin}/hook`, secret: { kind: "pasted", secret: SECRET } });
    await set();
    expect(await fileVault(join(t.dataDir, VAULT_FILE)).get("endpoint:hermes")).toBeUndefined();
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: `${receiver.origin}/hook`, secret: { kind: "pasted", secret: ROTATED } });
    expect((await client.request("routines.endpoints.list", {})).endpoints[0]).not.toHaveProperty("reference");
  });

  it("releases a delivery's resolved secret when shutdown aborts its POST", async () => {
    const { t, client, bao, receiver, set } = await setup();
    bao.secret("personal", "harness/endpoint-hermes", { secret: SECRET });
    await set();
    receiver.answer("hang");
    const received = receiver.next();
    const routine = await created(client, written({ schedule: { kind: "manual" }, delivery: [{ kind: "webhook", target: "hermes", on: "both" }] }));
    t.adapter.nextScripts.push(() => [end("completed", { resultText: "Digest filed." })]);
    await ranNow(client, routine.state.id);
    await received;
    expect(t.scrub.scrub(SECRET)).toBe("[redacted]");
    await t.close();
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
  });

});
