import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { end } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { created, history, ranNow, routineCommand, untilRoutineEvent, untilSettled, written } from "../../test/routines.js";
import { webhookReceiver } from "../../test/webhook-receiver.js";
import * as eventLog from "../event-log/event-log.js";

const { onCleanup, tempDir } = useCleanups();
const setup = async () => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const receiver = await webhookReceiver();
  onCleanup(() => receiver.close());
  const t = await startTestEnvironment({ dataDir });
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "hermes", url: receiver.origin, secret: { kind: "pasted", secret: "token-for-tests" } });
  const routine = await created(client, written({ schedule: { kind: "manual" }, delivery: [{ kind: "webhook", target: "hermes", on: "both" }] }));
  const fire = async (text = "Digest filed.") => {
    t.adapter.nextScripts.push(() => [end("completed", { resultText: text })]);
    const id = await ranNow(client, routine.state.id);
    await untilSettled(t, routine.state.id, id);
    return id;
  };
  return { t, dataDir, receiver, client, routine, fire };
};

/** Inject faults at the persistent log boundary while keeping the real environment and receiver. */
const onOpenedLog = (use: (log: eventLog.EventLog) => void) => {
  const open = eventLog.openEventLog;
  const spy = vi.spyOn(eventLog, "openEventLog").mockImplementation((options) => {
    const log = open(options);
    use(log);
    return log;
  });
  onCleanup(() => spy.mockRestore());
  return spy;
};

describe("webhook startup recovery", () => {
  it("does no entry recovery reads for completed and ineligible history", async () => {
    const { t, dataDir, receiver, client, routine, fire } = await setup();
    const delivered = await fire();
    await untilRoutineEvent(t, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === delivered);
    receiver.answer({ status: 400 });
    const failed = await fire();
    await untilRoutineEvent(t, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === failed);
    await fire("[SILENT]");
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [{ kind: "webhook", target: "hermes", on: "failure" }] } });
    await fire();
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [] } });
    await fire();
    await t.close();
    const reads: unknown[][] = [];
    onOpenedLog((log) => {
      const read = log.read.bind(log);
      vi.spyOn(log, "read").mockImplementation((sql, ...params) => {
        if (sql.includes("SELECT r.definition, e.targets, e.entry")) reads.push([...params]);
        return read(sql, ...params);
      });
    });
    const restarted = await startTestEnvironment({ dataDir });
    onCleanup(() => restarted.close());
    expect(reads).toEqual([]);
    expect(receiver.received).toHaveLength(2);
  });
  it("recovers an end whose initial enqueue failed before any POST", async () => {
    const { t, dataDir, receiver, routine, fire } = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const read = t.env.log.read.bind(t.env.log);
    vi.spyOn(t.env.log, "read").mockImplementation((sql, ...params) => {
      if (sql.includes("SELECT r.definition, e.targets, e.entry")) throw new Error("Initial enqueue refused for tests");
      return read(sql, ...params);
    });
    const entryId = await fire();
    await t.close();
    expect(receiver.received).toEqual([]);
    expect(errors.mock.calls.some((args) => String(args[0]).includes(entryId))).toBe(true);
    const restarted = await startTestEnvironment({ dataDir });
    onCleanup(() => restarted.close());
    await untilRoutineEvent(restarted, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId);
    expect(receiver.received.map((post) => post.headers["webhook-id"])).toEqual([`${entryId}:hermes:both`]);
    const client = await restarted.client();
    expect((await history(client, routine.state.id))[0]?.deliveries[0]?.attempts).toHaveLength(1);
  });

  it.each(["entry read", "attempt write"])("contains a recovery %s fault, recovers other entries, and leaves the failed entry for the next restart", async (fault) => {
    const { t, dataDir, receiver, routine, fire } = await setup();
    receiver.answer("hang");
    const firstPost = receiver.next();
    const first = await fire();
    await firstPost;
    const secondPost = receiver.next();
    const second = await fire();
    await secondPost;
    await t.close();
    receiver.answer({ status: 204 });
    // The two entries' attempts run concurrently, so the first's refusal is waited on itself, not inferred from the second's attempt.
    let refused!: () => void;
    const firstRefused = new Promise<void>((resolve) => { refused = resolve; });
    const errors = vi.spyOn(console, "error").mockImplementation((message: unknown) => { if (String(message).includes(first)) refused(); });
    onCleanup(() => errors.mockRestore());
    const injection = onOpenedLog((log) => {
      const read = log.read.bind(log);
      vi.spyOn(log, "read").mockImplementation((sql, ...params) => {
        if (fault === "entry read" && sql.includes("SELECT r.definition, e.targets, e.entry") && params[0] === first) throw new Error("Recovery read refused for tests");
        return read(sql, ...params);
      });
      const append = log.append.bind(log);
      vi.spyOn(log, "append").mockImplementation((stream, events, attribution) => {
        if (fault === "attempt write" && events.some((event) => event.type === "routine.delivery-attempted" && event.payload["entryId"] === first)) throw new Error("Recovery write refused for tests");
        return append(stream, events, attribution);
      });
    });
    const restarted = await startTestEnvironment({ dataDir });
    onCleanup(() => restarted.close());
    await Promise.all([firstRefused, untilRoutineEvent(restarted, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === second)]);
    await restarted.close();
    injection.mockRestore();
    const again = await startTestEnvironment({ dataDir });
    onCleanup(() => again.close());
    await untilRoutineEvent(again, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === first);
    const client = await again.client();
    expect((await history(client, routine.state.id)).map((entry) => entry.deliveries[0]?.result)).toEqual(["delivered", "delivered"]);
    expect(receiver.received.filter((post) => post.headers["webhook-id"] === `${second}:hermes:both`)).toHaveLength(2);
  });

  it("contains a pending queue scan fault and recovers the lost initial attempt on the next restart", async () => {
    const { t, dataDir, receiver, routine, fire } = await setup();
    receiver.answer("hang");
    const posted = receiver.next();
    const entryId = await fire();
    await posted;
    await t.close();
    receiver.answer({ status: 204 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const injection = onOpenedLog((log) => {
      const read = log.read.bind(log);
      vi.spyOn(log, "read").mockImplementation((sql, ...params) => {
        if (sql.includes("FROM routine_webhook_pending WHERE ready = 1")) throw new Error("Queue scan refused for tests");
        return read(sql, ...params);
      });
    });
    const restarted = await startTestEnvironment({ dataDir });
    onCleanup(() => restarted.close());
    const client = await restarted.client();
    expect((await history(client, routine.state.id))[0]?.deliveries).toEqual([]);
    expect(receiver.received).toHaveLength(1);
    expect(errors.mock.calls.some((args) => String(args[0]).includes("Queue scan refused for tests"))).toBe(true);
    await restarted.close();
    injection.mockRestore();
    const again = await startTestEnvironment({ dataDir });
    onCleanup(() => again.close());
    await untilRoutineEvent(again, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId);
    expect(receiver.received.map((post) => post.headers["webhook-id"])).toEqual([`${entryId}:hermes:both`, `${entryId}:hermes:both`]);
  });

  it.each([false, true])("rebuilds captured targets and their original retry deadline, including overdue retries (%s)", async (overdue) => {
    const { t, dataDir, receiver, client, routine, fire } = await setup();
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name: "other", url: receiver.origin, secret: { kind: "pasted", secret: "token-for-tests" } });
    const targets = [{ kind: "webhook" as const, target: "hermes", on: "both" as const }, { kind: "webhook" as const, target: "other", on: "success" as const }];
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [...targets, targets[0]!] } });
    receiver.answer({ status: 503 });
    const entryId = await fire();
    const attempted = (env: typeof t, attempt: number, target: string) => untilRoutineEvent(env, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId && e.payload["attempt"] === attempt && (e.payload["target"] as { target: string }).target === target);
    await Promise.all(targets.map((target) => attempted(t, 1, target.target)));
    t.clock.advance(60_000);
    for (const target of targets) expect((await attempted(t, 2, target.target)).payload["retryAt"]).toBe("2026-09-24T00:06:00.000Z");
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [] } });
    t.env.log.rebuildProjections();
    await t.close();
    receiver.answer({ status: 204 });
    const clock = manualClock(overdue ? "2026-09-24T00:07:00.000Z" : "2026-09-24T00:03:00.000Z");
    const restarted = await startTestEnvironment({ dataDir, clock });
    onCleanup(() => restarted.close());
    if (!overdue) {
      clock.advance(179_999);
      expect(receiver.received).toHaveLength(4);
      clock.advance(1);
    }
    await Promise.all(targets.map((target) => attempted(restarted, 3, target.target)));
    expect(receiver.received.map((post) => post.headers["webhook-id"]).sort()).toEqual([
      ...Array<string>(3).fill(`${entryId}:hermes:both`), ...Array<string>(3).fill(`${entryId}:other:success`),
    ].sort());
    const restartedClient = await restarted.client();
    expect((await history(restartedClient, routine.state.id))[0]?.deliveries.map((delivery) => delivery.result)).toEqual(["delivered", "delivered"]);
  });

  it("rebuilds a failing skip's captured failure target after the routine is edited", async () => {
    const { t, dataDir, receiver, client, routine } = await setup();
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: {
      model: "model-not-offered", delivery: [
        { kind: "webhook", target: "hermes", on: "failure" },
        { kind: "webhook", target: "hermes", on: "success" },
      ],
    } });
    receiver.answer("hang");
    const posted = receiver.next();
    const entryId = await ranNow(client, routine.state.id);
    await posted;
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { delivery: [] } });
    t.env.log.rebuildProjections();
    await t.close();
    receiver.answer({ status: 204 });
    const restarted = await startTestEnvironment({ dataDir });
    onCleanup(() => restarted.close());
    await untilRoutineEvent(restarted, routine.state.id, (e) => e.type === "routine.delivery-attempted" && e.payload["entryId"] === entryId);
    expect(receiver.received.map((post) => post.headers["webhook-id"])).toEqual([`${entryId}:hermes:failure`, `${entryId}:hermes:failure`]);
    const restartedClient = await restarted.client();
    expect((await history(restartedClient, routine.state.id))[0]).toMatchObject({ kind: "skip", deliveries: [{ result: "delivered" }] });
  });

});
