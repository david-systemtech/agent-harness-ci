import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RoutineDeliveryAttemptedPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end } from "../../test/fake-adapter.js";
import { startFakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle } from "../../test/key-manager-connections.js";
import { history, ranNow, routineCommand, untilRoutineEvent, untilSettled } from "../../test/routines.js";
import { verifyStandardWebhook, type ReceivedRequest } from "../../test/webhook-receiver.js";

const { onCleanup } = useCleanups();
const SECRET = "hermes-route-secret-for-tests";
const document = readFileSync(new URL("../../../../docs/routines/upstream-watch.md", import.meta.url), "utf8").split("```yaml\n")[1]!.split("```")[0]!;

/** A delivering-only receiver boundary, not the live Hermes adapter or Matrix. */
const setup = async () => {
  const t = await startTestEnvironment({ name: "SYSTEM-SERVER" });
  onCleanup(() => t.close());
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "endpoints"] });
  bao.policy("endpoints", 'path "personal/data/agents/endpoint-hermes" { capabilities = ["read"] }');
  bao.kv("personal", 2);
  bao.secret("personal", "agents/endpoint-hermes", { secret: SECRET });
  const received: ReceivedRequest[] = [];
  const room: { id: string; body: unknown }[] = [];
  const delivered = new Set<string>();
  let loseAcknowledgement = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const taken: ReceivedRequest = { method: request.method ?? "", path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(taken);
      if (!verifyStandardWebhook(SECRET, taken, t.clock.now())) {
        response.writeHead(401).end();
        return;
      }
      const id = String(taken.headers["webhook-id"]);
      if (!delivered.has(id)) {
        room.push({ id, body: JSON.parse(taken.body) });
        delivered.add(id);
      }
      const status = loseAcknowledgement ? 503 : 204;
      loseAcknowledgement = false;
      response.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onCleanup(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/harness`;
  const client = await t.client();
  const connection = await added(client, { label: "Personal OpenBao", address: bao.address, ca: bao.ca, credential: approle() });
  const set = await client.request("routines.endpoints.set", {
    commandId: randomUUID(), name: "hermes", url,
    secret: { kind: "reference", reference: { provider: "openbao", connectionId: connection.id, mount: "personal", path: "agents/endpoint-hermes", key: "secret" } },
  });
  expect(set.receipt.status).toBe("accepted");
  const imported = await routineCommand(client, "routines.import", { yaml: document });
  const routine = imported.result?.routines[0];
  if (routine === undefined) throw new Error("Upstream watch document was not imported");
  expect(routine.definition).toMatchObject({ enabled: false, delivery: [{ kind: "client-notice", on: "both" }, { kind: "webhook", target: "hermes", on: "success" }] });
  // Replace only the machine/provider/probe fields with the in-process fixtures.
  await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { workspace: { kind: "scratch", repositoryIdentity: null }, account: null, model: null, preCheck: null } });
  const fire = async (reason: "completed" | "error", text: string) => {
    t.adapter.nextScripts.push(() => [end(reason, { resultText: text })]);
    return ranNow(client, routine.state.id);
  };
  const attempted = (entryId: string, attempt: number) => untilRoutineEvent(t, routine.state.id, (event) => event.type === "routine.delivery-attempted" && event.payload["entryId"] === entryId && event.payload["attempt"] === attempt && RoutineDeliveryAttemptedPayload.parse(event.payload).target.kind === "webhook");
  return { t, client, routine, received, room, fire, attempted, loseNextAcknowledgement: () => { loseAcknowledgement = true; } };
};

describe("upstream watch results through the Hermes endpoint", { timeout: 60_000 }, () => {
  it("tests the reference-backed endpoint, then retries a lost acknowledgement with one result in the receiver's room", async () => {
    const { t, client, routine, received, room, fire, attempted, loseNextAcknowledgement } = await setup();
    expect(await client.request("routines.endpoints.test", { name: "hermes" })).toMatchObject({ status: 204, error: null });
    expect(room).toHaveLength(1);
    expect(room[0]?.body).toMatchObject({ type: "routine.test", version: 1 });
    expect((await client.request("routines.endpoints.list", {})).endpoints).toMatchObject([{ name: "hermes", secretKind: "reference", reference: { locator: "personal/agents/endpoint-hermes (key secret)" } }]);
    loseNextAcknowledgement();
    const entryId = await fire("completed", "Digest filed.\nSee issue #123.");
    expect((await attempted(entryId, 1)).payload).toMatchObject({ result: "retrying", status: 503 });
    t.clock.advance(60_000);
    expect((await attempted(entryId, 2)).payload).toMatchObject({ result: "delivered", status: 204 });
    expect(received.slice(1).map((request) => request.headers["webhook-id"])).toEqual([`${entryId}:hermes:success`, `${entryId}:hermes:success`]);
    expect(room).toHaveLength(2);
    expect(room[1]?.body).toMatchObject({ type: "routine.result", version: 1, environment: { name: "SYSTEM-SERVER" }, routine: { name: "Upstream watch" }, entry: { id: entryId, outcome: "succeeded" }, text: "Digest filed.\nSee issue #123." });
    expect((await history(client, routine.state.id))[0]?.deliveries).toMatchObject([
      { target: { kind: "client-notice", on: "both" }, result: "delivered" },
      { target: { kind: "webhook", target: "hermes", on: "success" }, result: "delivered", attempts: [{ status: 503 }, { status: 204 }] },
    ]);
    const retry = received[2]!;
    expect(verifyStandardWebhook(SECRET, retry, t.clock.now())).toBe(true);
    expect(verifyStandardWebhook("wrong-secret-for-tests", retry, t.clock.now())).toBe(false);
    expect(verifyStandardWebhook(SECRET, { ...retry, body: retry.body + " " }, t.clock.now())).toBe(false);
    expect(verifyStandardWebhook(SECRET, retry, new Date(t.clock.now().getTime() + 301_000))).toBe(false);
    expect(verifyStandardWebhook(SECRET, retry, new Date(t.clock.now().getTime() - 301_000))).toBe(false);
  });

  it("keeps failure on the client notice and sends neither failure nor silence to Hermes", async () => {
    const { t, client, routine, received, room, fire } = await setup();
    const failed = await fire("error", "Probe failed.");
    await untilSettled(t, routine.state.id, failed);
    await untilRoutineEvent(t, routine.state.id, (event) => event.type === "routine.delivery-attempted" && event.payload["entryId"] === failed);
    expect((await history(client, routine.state.id))[0]?.deliveries).toMatchObject([{ target: { kind: "client-notice", on: "both" }, result: "delivered" }]);
    const silent = await fire("completed", "[SILENT]");
    expect((await untilSettled(t, routine.state.id, silent)).payload).toMatchObject({ outcome: "silent" });
    expect((await history(client, routine.state.id))[0]?.deliveries).toEqual([]);
    expect(received).toEqual([]);
    expect(room).toEqual([]);
  });
});
