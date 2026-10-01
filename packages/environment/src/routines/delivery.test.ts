import { randomUUID } from "node:crypto";
import {
  ENVIRONMENT_STREAM_KIND,
  MAX_DELIVERY_BODY,
  MAX_DELIVERY_SUMMARY,
  type DeliveryOn,
  type EventFrame,
  type FiringFailureReason,
  type FiringOutcome,
  type RoutineDefinitionInput,
  type RoutineDeliveredPayload,
  type RoutineEntry,
  type SkipReason,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, gate, say, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, ranNow, routineCommand, routineUpdates, untilSettled, untilStarted, written } from "../../test/routines.js";
import type { WireClient } from "../../test/wire-client.js";
import { scriptedResolver } from "../../test/workspaces.js";
import { deliveredOutcome, resumeDeliveries } from "./delivery.js";

/**
 * Delivery targets and the client notice (routines spec, "Delivery
 * targets"; #525), through the primary seam: an in-process environment and
 * real clients, the scripted fake provider and the manual clock. What is
 * asserted is what a client sees: `routine.delivered` on the environment's
 * stream, and the history's deliveries.
 */

const { onCleanup } = useCleanups();

/** A gate opened when the test ends, so a run it holds never outlives it. */
const heldGate = (): Gate => {
  const held = gate();
  onCleanup(() => held.open());
  return held;
};

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: "Asia/Manila", name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it, run now only. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ schedule: { kind: "manual" }, ...overrides });

/** Subscribes `client` to the environment's stream from its head now, so what it hears next is news. */
const listening = async (t: TestEnvironment, client: WireClient): Promise<string> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  await client.next((frame) => "subscription" in frame && frame.subscription === subscription && frame.type === "synchronized");
  return subscription;
};

/** The next `routine.delivered` the client hears on its subscription. */
const nextDelivered = async (client: WireClient, subscription: string): Promise<EventFrame["event"]> =>
  (
    (await client.next(
      (frame) => "subscription" in frame && frame.subscription === subscription && frame.type === "event" && (frame as EventFrame).event.type === "routine.delivered",
    )) as EventFrame
  ).event;

/** The `routine.delivered` notices on the environment's stream, each its payload. */
const deliveredOn = (t: TestEnvironment): RoutineDeliveredPayload[] =>
  t.env.log
    .readStream({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id })
    .filter((event) => event.type === "routine.delivered")
    .map((event) => event.payload as RoutineDeliveredPayload);

/** A firing of a fresh routine run now, whose run plays `script`, followed to its end: its routine, its id, its session and its end. */
const fired = async (t: TestEnvironment, client: WireClient, definition: RoutineDefinitionInput, script?: Script) => {
  const { state } = await created(client, definition);
  if (script !== undefined) t.adapter.nextScripts.push(script);
  const firingId = await ranNow(client, state.id);
  const { sessionId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string };
  const ended = await untilSettled(t, state.id, firingId);
  return { routineId: state.id, firingId, sessionId, ended };
};

describe("a client-notice target", () => {
  it("resumes notices without reading entries already delivered, even after a projection rebuild", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());
    for (let i = 0; i < 8; i += 1) {
      const firingId = await ranNow(client, state.id);
      await untilSettled(t, state.id, firingId);
    }
    expect(deliveredOn(t)).toHaveLength(8);
    t.env.log.rebuildProjections();
    const reads = vi.spyOn(t.env.log, "read");
    const streams = vi.spyOn(t.env.log, "readStream");
    resumeDeliveries({ log: t.env.log, clock: () => t.clock.now(), environmentId: t.env.id });
    // Count materialized rows rather than relying on a wall-clock performance budget.
    const rows = reads.mock.results.reduce((count, result) => count + (result.type === "return" ? result.value.length : 0), 0);
    expect(rows).toBe(0);
    expect(streams).not.toHaveBeenCalled();
    reads.mockRestore();
    streams.mockRestore();
    expect(deliveredOn(t)).toHaveLength(8);
  });

  it("appends routine.delivered on the environment's stream once a succeeded firing's end commits, and two connected clients each hear it", async () => {
    const t = await start();
    const desk = await t.client();
    const phone = await t.client();
    const subscriptions = [await listening(t, desk), await listening(t, phone)] as const;
    const text = "\n  Three new releases; digest filed.  \nThe details follow.";

    const firing = await fired(t, desk, routine({ name: "Upstream watch" }), () => [say("Reading the sources."), end("completed", { resultText: text })]);

    const expected: RoutineDeliveredPayload = {
      routineId: firing.routineId,
      name: "Upstream watch",
      entryId: firing.firingId,
      entryKind: "firing",
      sessionId: firing.sessionId,
      outcome: "succeeded",
      summary: "Three new releases; digest filed.",
      body: text,
    };
    for (const [client, subscription] of [
      [desk, subscriptions[0]],
      [phone, subscriptions[1]],
    ] as const) {
      const event = await nextDelivered(client, subscription);
      expect(event).toMatchObject({ streamKind: "environment", actor: { kind: "routine", id: firing.routineId }, causationId: firing.ended.eventId, payload: expected });
      expect(event.sequence).toBeGreaterThan(firing.ended.sequence);
    }
    expect(deliveredOn(t)).toEqual([expected]);
  });

  it("says a failed firing's reason, with what it said as its body, and a cannot-start skip's detail, with no session", async () => {
    const t = await start();
    const client = await t.client();
    const failed = await fired(t, client, routine({ name: "Nightly receipts" }), () => [say("Trying."), end("error", { error: { message: "The provider failed.", code: null } })]);
    const { state } = await created(client, routine({ name: "Unoffered", model: "a-model-nobody-offers" }));
    const skipId = await ranNow(client, state.id);
    await untilSettled(t, state.id, skipId);

    expect(deliveredOn(t)).toEqual([
      {
        routineId: failed.routineId,
        name: "Nightly receipts",
        entryId: failed.firingId,
        entryKind: "firing",
        sessionId: failed.sessionId,
        outcome: "failed",
        summary: "The firing's run ended in an error.",
        body: "Trying.",
      },
      {
        routineId: state.id,
        name: "Unoffered",
        entryId: skipId,
        entryKind: "skip",
        sessionId: null,
        outcome: "failed",
        summary: "The firing could not start: The account claude-max does not offer the model a-model-nobody-offers.",
        body: "The account claude-max does not offer the model a-model-nobody-offers.",
      },
    ]);
  });

  it("says a succeeded firing that said nothing finished without a final message, and a failed one that said nothing its reason", async () => {
    const t = await start();
    const client = await t.client();
    await fired(t, client, routine({ name: "Said nothing" }), () => [end()]);
    await fired(t, client, routine({ name: "Failed quietly" }), () => [end("error", { error: { message: "The provider failed.", code: null } })]);
    expect(deliveredOn(t).map(({ name, outcome, summary, body }) => ({ name, outcome, summary, body }))).toEqual([
      { name: "Said nothing", outcome: "succeeded", summary: "The firing finished without a final message.", body: "The firing finished without a final message." },
      { name: "Failed quietly", outcome: "failed", summary: "The firing's run ended in an error.", body: "The firing's run ended in an error." },
    ]);
  });

  it("cuts the summary to 200 characters and the body to 4,000", async () => {
    const t = await start();
    const client = await t.client();
    const line = "y".repeat(MAX_DELIVERY_SUMMARY + 50);
    const text = `${line}\n${"z".repeat(MAX_DELIVERY_BODY)}`;
    await fired(t, client, routine(), () => [end("completed", { resultText: text })]);
    const [delivered] = deliveredOn(t);
    expect(delivered?.summary).toBe(line.slice(0, MAX_DELIVERY_SUMMARY));
    expect(delivered?.body).toBe(text.slice(0, MAX_DELIVERY_BODY));
  });

  it("is listed on the history's entry: one attempt, delivered, and routine.updated says so", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const firing = await fired(t, client, routine({ delivery: [{ kind: "client-notice", on: "success" }] }));
    const [entry] = await history(client, firing.routineId);
    expect(entry?.deliveries).toEqual([
      {
        target: { kind: "client-notice", on: "success" },
        result: "delivered",
        attempts: [{ attempt: 1, at: MANUAL_CLOCK_START, result: "delivered", status: null, error: null, retryAt: null }],
      },
    ]);
    const updates = await routineUpdates(await t.client(), head);
    expect(updates.map((event) => event.payload["change"])).toEqual(["created", "firing-started", "firing-ended", "delivery-attempted"]);
  });
});

describe("delivery by outcome", () => {
  /** One routine per `on`, each with a client notice on it alone, named by it. */
  const ONS: readonly DeliveryOn[] = ["success", "failure", "both"];
  const byOn = async (client: WireClient, overrides: Partial<RoutineDefinitionInput> = {}) =>
    Promise.all(ONS.map(async (on) => (await created(client, routine({ name: on, delivery: [{ kind: "client-notice", on }], ...overrides }))).state.id));

  /** Runs each routine now with `script` for its run, following each to its end: the names of the routines whose result was delivered. */
  const deliveredNames = async (t: TestEnvironment, client: WireClient, routineIds: readonly string[], script?: () => Script) => {
    for (const routineId of routineIds) {
      if (script !== undefined) t.adapter.nextScripts.push(script());
      await untilSettled(t, routineId, await ranNow(client, routineId));
    }
    return deliveredOn(t).map((delivered) => delivered.name);
  };

  it("sends a succeeded firing to targets on success or both", async () => {
    const t = await start();
    const client = await t.client();
    expect(await deliveredNames(t, client, await byOn(client))).toEqual(["success", "both"]);
  });

  it("sends a failed firing to targets on failure or both", async () => {
    const t = await start();
    const client = await t.client();
    const failing = () => () => [end("error", { error: { message: "The provider failed.", code: null } })];
    expect(await deliveredNames(t, client, await byOn(client), failing)).toEqual(["failure", "both"]);
  });

  it("sends a cannot-start skip, a failing skip, to targets on failure or both", async () => {
    const t = await start();
    const client = await t.client();
    expect(await deliveredNames(t, client, await byOn(client, { model: "a-model-nobody-offers" }))).toEqual(["failure", "both"]);
  });

  it("sends a cancelled firing to none", async () => {
    const t = await start();
    const client = await t.client();
    for (const routineId of await byOn(client)) {
      const held = heldGate();
      t.adapter.nextScripts.push(async function* () {
        yield say("Working");
        await held.opened;
        yield end();
      });
      const firingId = await ranNow(client, routineId);
      const { runId } = (await untilStarted(t, routineId, firingId)).payload as { runId: string };
      await client.apply("runs.interrupt", { commandId: randomUUID(), runId });
      expect((await untilSettled(t, routineId, firingId)).payload).toMatchObject({ outcome: "cancelled" });
    }
    expect(deliveredOn(t)).toEqual([]);
  });

  it("raises nothing for a routine with no client-notice target", async () => {
    const t = await start();
    const client = await t.client();
    const none = await created(client, routine({ name: "No targets", delivery: [] }));
    const webhook = await created(client, routine({ name: "Webhook only", delivery: [{ kind: "webhook", target: "hermes", on: "both" }] }));
    for (const { state } of [none, webhook]) await untilSettled(t, state.id, await ranNow(client, state.id));
    expect(deliveredOn(t)).toEqual([]);
    expect((await history(client, none.state.id))[0]?.deliveries).toEqual([]);
  });

  it("delivers once to clients however many client-notice targets take the result, and lists a delivery to each distinct target", async () => {
    const t = await start();
    const client = await t.client();
    const delivery = [
      { kind: "client-notice", on: "success" },
      { kind: "client-notice", on: "failure" },
      { kind: "client-notice", on: "both" },
      { kind: "client-notice", on: "success" },
    ] as const;
    const firing = await fired(t, client, routine({ delivery: [...delivery] }));
    expect(deliveredOn(t)).toHaveLength(1);
    expect((await history(client, firing.routineId))[0]?.deliveries.map((made) => [made.target, made.result])).toEqual([
      [{ kind: "client-notice", on: "success" }, "delivered"],
      [{ kind: "client-notice", on: "both" }, "delivered"],
    ]);
  });
});

describe("the targets an entry delivers to", () => {
  it("are, for a firing, the ones routine.firing-started recorded: an edit during the firing changes nothing for it", async () => {
    const t = await start();
    const client = await t.client();
    const fire = async (from: DeliveryOn, to: RoutineDefinitionInput["delivery"]) => {
      const { state } = await created(client, routine({ name: `From ${from}`, delivery: [{ kind: "client-notice", on: from }] }));
      const held = heldGate();
      t.adapter.nextScripts.push(async function* () {
        await held.opened;
        yield end("completed", { resultText: "Done." });
      });
      const firingId = await ranNow(client, state.id);
      await untilStarted(t, state.id, firingId);
      await routineCommand(client, "routines.update", { routineId: state.id, fields: { delivery: to } });
      held.open();
      await untilSettled(t, state.id, firingId);
    };
    await fire("both", []);
    await fire("failure", [{ kind: "client-notice", on: "both" }]);
    expect(deliveredOn(t).map((delivered) => delivered.name)).toEqual(["From both"]);
  });

  it("are, for a skip, its routine's at its record: an edit before the skip is recorded counts, and a routine deleted by then delivers nothing", async () => {
    const resolving = heldGate();
    const resolver = scriptedResolver(async () => {
      await resolving.opened;
      throw new Error("The disk is gone.");
    });
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const edited = await created(client, routine({ name: "Edited", delivery: [] }));
    const deleted = await created(client, routine({ name: "Deleted" }));
    const editedSkip = await ranNow(client, edited.state.id);
    const deletedSkip = await ranNow(client, deleted.state.id);
    await routineCommand(client, "routines.update", { routineId: edited.state.id, fields: { delivery: [{ kind: "client-notice", on: "failure" }] } });
    await routineCommand(client, "routines.delete", { routineId: deleted.state.id });
    resolving.open();
    await untilSettled(t, edited.state.id, editedSkip);
    await untilSettled(t, deleted.state.id, deletedSkip);

    expect(deliveredOn(t)).toEqual([expect.objectContaining({ name: "Edited", entryId: editedSkip, entryKind: "skip", summary: "The firing could not start: The disk is gone." })]);
  });
});

describe("which ended entries are delivered", () => {
  /** An ended firing, as the history lists it. */
  const firingEnded = (outcome: FiringOutcome, reason: FiringFailureReason | null = null): RoutineEntry => ({
    kind: "firing",
    id: randomUUID(),
    trigger: "schedule",
    count: 1,
    preCheck: null,
    deliveries: [],
    dueAt: MANUAL_CLOCK_START,
    startedAt: MANUAL_CLOCK_START,
    endedAt: MANUAL_CLOCK_START,
    sessionId: randomUUID(),
    runId: randomUUID(),
    requestedBy: null,
    targets: [],
    outcome,
    reason,
    text: "",
    usage: null,
    durationMs: 0,
    baselineAdvanced: false,
  });
  /** A skip, as the history lists it. */
  const skipped = (reason: SkipReason): RoutineEntry => ({
    kind: "skip",
    id: randomUUID(),
    trigger: "schedule",
    count: 1,
    preCheck: null,
    deliveries: [],
    dueAt: MANUAL_CLOCK_START,
    at: MANUAL_CLOCK_START,
    reason,
    cannotStart: null,
    detail: null,
  });

  // Every kind of end, read here; a silent firing through the wire is firing-end.test.ts's (#524).
  it.each([
    ["a succeeded firing", firingEnded("succeeded"), "succeeded"],
    ["a failed firing", firingEnded("failed", "timed_out"), "failed"],
    ["a silent firing", firingEnded("silent"), "nothing"],
    ["a cancelled firing", firingEnded("cancelled"), "nothing"],
    ["a pre-check-failed skip", skipped("pre-check-failed"), "failed"],
    ["a cannot-start skip", skipped("cannot-start"), "failed"],
    ["a no-change skip", skipped("no-change"), "nothing"],
    ["a missed skip", skipped("missed"), "nothing"],
    ["an overlap skip", skipped("overlap"), "nothing"],
  ] as const)("delivers %s as %s", (_what, entry, outcome) => {
    expect(deliveredOutcome(entry) ?? "nothing").toBe(outcome);
  });
});
