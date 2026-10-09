import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { registry, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterDescriptor, AdapterRun } from "../adapter/contract.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Gate, type Script } from "../../test/fake-adapter.js";
import { createGroup } from "../../test/groups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, deleteSession, get, listStream, patchOf, rename } from "../../test/sessions.js";
import { DAY, MINUTE, SWEEP_EVERY, pass, updateSettings } from "../../test/shelf.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Activity companions and the title fallback through the primary seam
 * (session-state spec, "Events", "The list stream and the summary patch",
 * "Auto-settle" and "Title fallback"): real runs of the scripted fake
 * adapter driven by a real client. A run's start unarchives, unsettles and
 * wakes its session, a run's end wakes it, each in the run event's
 * transaction with it as causation, on every path a run starts or ends by;
 * the first user message generates the title, a provider's title replaces
 * it unless the user set one, and a user title is mirrored to the provider
 * after commit, once the session has run, and never read back. Nothing
 * writes the provider's tag field.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

type RunCommand = "runs.start" | "runs.send" | "runs.interrupt";

/** Sends a run command with a fresh command id (unless one is given); resolves with its response, checked against its schema. */
const run = async <N extends RunCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId"> & { commandId?: string }) =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Starts a run and resolves with its ids and the receipt's sequence; throws unless it was accepted. */
const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts", commandId = randomUUID()) => {
  const answer = await run(client, "runs.start", { sessionId, text, commandId });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return { ...answer.result, sequence: answer.receipt.sequence };
};

/** The session's events on the log after `sequence`, up to `through` when given. */
const eventsOf = (t: TestEnvironment, sessionId: string, after: number, through = Number.MAX_SAFE_INTEGER): EventEnvelope[] =>
  t.env.log.readStream({ kind: "session", id: sessionId }, after).filter((event) => event.sequence <= through);

/** The session's first event of `type` after `sequence` whose run is `runId` when given, once it is on the log. */
const waitForEvent = async (t: TestEnvironment, sessionId: string, after: number, type: string, runId?: string): Promise<EventEnvelope> => {
  let found: EventEnvelope | undefined;
  await vi.waitFor(() => {
    found = eventsOf(t, sessionId, after).find((event) => event.type === type && (runId === undefined || event.payload["runId"] === runId));
    expect(found, `a ${type} on the log`).toBeDefined();
  });
  return found as EventEnvelope;
};

/** The events from `first` on, `count` of them. */
const from = (t: TestEnvironment, first: EventEnvelope, count: number): EventEnvelope[] =>
  eventsOf(t, first.streamId, first.sequence - 1).slice(0, count);

/** Asserts `events` were appended together: consecutive sequences, one instant, one command id (or none) and one actor. */
const expectOneTransaction = (events: readonly EventEnvelope[]) => {
  const [first] = events;
  if (first === undefined) throw new Error("No events.");
  events.forEach((event, i) => {
    expect(event, event.type).toMatchObject({ sequence: first.sequence + i, occurredAt: first.occurredAt, commandId: first.commandId, actor: first.actor });
  });
};

/** A script held until `held` opens: it says it is working, waits, then finishes. */
const heldScript =
  (held: Gate): Script =>
  async function* () {
    yield say("Working");
    await held.opened;
    yield end();
  };

describe("a run's start", () => {
  it("unarchives, unsettles (reason activity) and wakes (reason activity) its session in runs.start's transaction, each naming run.started as its causation", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await command(client, "sessions.archive", { sessionId: id });
    await command(client, "sessions.settle", { sessionId: id });
    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(MINUTE);
    const head = t.env.log.head();
    const commandId = randomUUID();

    const { sequence } = await startRun(client, id, "Fix the receipts", commandId);

    const events = eventsOf(t, id, head, sequence);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "run.browser.resolved",
      "message.sent",
      "session.unarchived",
      "session.unsettled",
      "session.unsnoozed",
      "session.title-generated",
    ]);
    expectOneTransaction(events);
    const [started, , , sent, unarchived, unsettled, unsnoozed, titled] = events as [
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
    ];
    expect(started).toMatchObject({ commandId, occurredAt: at(MINUTE), actor: `client_session:${client.hello.clientSessionId}` });
    expect([unarchived, unsettled, unsnoozed].map((event) => event.causationId)).toEqual([started.eventId, started.eventId, started.eventId]);
    expect(titled.causationId).toBe(sent.eventId);
    expect(unarchived.payload).toEqual({});
    expect(unsettled.payload).toEqual({ unsettledAt: at(MINUTE), reason: "activity" });
    expect(unsnoozed.payload).toEqual({ reason: "activity" });

    // On the list, each with its patch: the run's activity, then the session back in the active list.
    const listed = [await list.next(), await list.next(), await list.next(), await list.next(), await list.next()] as const;
    expect(listed.map((event) => event.type)).toEqual(["run.started", "session.unarchived", "session.unsettled", "session.unsnoozed", "session.title-generated"]);
    expect(patchOf(listed[1])).toEqual({ op: "set", sessionId: id, fields: { archivedAt: null, updatedAt: at(MINUTE) } });
    expect(patchOf(listed[2])).toEqual({
      op: "set",
      sessionId: id,
      fields: { settledAt: null, settledOverride: null, settledBy: null, unsettledAt: at(MINUTE) },
    });
    // Every companion moves updatedAt to the run's instant: the unarchive's patch carries it, and the patches after it,
    // in the same transaction at the same instant, have nothing left to change there (a patch is the fields that changed).
    expect(patchOf(listed[3])).toEqual({ op: "set", sessionId: id, fields: { snoozedUntil: null, snoozedAt: null } });
    expect(await get(client, id)).toMatchObject({
      updatedAt: at(MINUTE),
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      settledBy: null,
      unsettledAt: at(MINUTE),
      snoozedUntil: null,
      title: "Fix the receipts",
    });
  });

  it("owes each companion only for what there is to undo: an archive alone, a settle alone, a snooze alone, and nothing on an active session", async () => {
    const t = await start();
    const client = await t.client();
    const cases: [string, (id: string) => Promise<unknown>, string[]][] = [
      ["archived", (id) => command(client, "sessions.archive", { sessionId: id }), ["session.unarchived"]],
      ["settled", (id) => command(client, "sessions.settle", { sessionId: id }), ["session.unsettled"]],
      ["snoozed", (id) => command(client, "sessions.snooze", { sessionId: id, until: at(DAY) }), ["session.unsnoozed"]],
      ["active", async () => undefined, []],
    ];
    for (const [name, prepare, companions] of cases) {
      const { id } = await create(client);
      await prepare(id);
      const head = t.env.log.head();
      const { sequence } = await startRun(client, id);
      const types = eventsOf(t, id, head, sequence).map((event) => event.type);
      expect(types, name).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", ...companions, "session.title-generated"]);
    }
  });

  it("moves updatedAt to the run's start with the companion alone, as a shelf event does, and leaves the active order and the auto-settle anchor to the run's instant", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await command(client, "sessions.settle", { sessionId: id });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(MINUTE);

    await startRun(client, id);

    expect((await list.next()).type).toBe("run.started");
    const unsettled = await list.next();
    expect(unsettled.type).toBe("session.unsettled");
    expect(patchOf(unsettled)).toEqual({
      op: "set",
      sessionId: id,
      fields: { settledAt: null, settledOverride: null, settledBy: null, unsettledAt: at(MINUTE), updatedAt: at(MINUTE) },
    });
    expect(await get(client, id)).toMatchObject({ updatedAt: at(MINUTE), unsettledAt: at(MINUTE), lastActivityAt: at(MINUTE) });
  });

  it("clears a user's active override on a session that is not settled, with session.unsettled reason activity, so auto-settle applies again", async () => {
    const t = await start();
    let client = await t.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": { amount: 1, unit: "days" } });
    const { id } = await create(client);
    await command(client, "sessions.unsettle", { sessionId: id });
    client = await pass(t, client, 3 * DAY);
    expect(await get(client, id)).toMatchObject({ settledAt: null, settledOverride: "active" });
    const list = await listStream(client, t.env.log.head());
    const head = t.env.log.head();

    const { runId, sequence } = await startRun(client, id);

    const events = eventsOf(t, id, head, sequence);
    expect(events.map((event) => [event.type, event.payload["reason"]])).toEqual([
      ["run.started", undefined],
      ["run.policy.resolved", undefined],
      ["run.browser.resolved", "headless-unavailable"],
      ["message.sent", undefined],
      ["session.unsettled", "activity"],
      ["session.title-generated", undefined],
    ]);
    expect(events[4]?.causationId).toBe(events[0]?.eventId);
    await list.next();
    expect(patchOf(await list.next())).toEqual({ op: "set", sessionId: id, fields: { settledOverride: null, unsettledAt: at(3 * DAY), updatedAt: at(3 * DAY) } });
    await waitForEvent(t, id, head, "run.ended", runId);
    expect(await get(client, id)).toMatchObject({ settledOverride: null, activity: { state: "idle" } });

    // A day of quiet after the run, and the sweep settles it: the override no longer holds it.
    client = await pass(t, client, DAY + SWEEP_EVERY);
    expect(await get(client, id)).toMatchObject({ settledBy: "auto-idle", settledOverride: "settled" });
  });

  it("owes its companions on a run runs.send starts, in the send's transaction", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await command(client, "sessions.archive", { sessionId: id });
    const head = t.env.log.head();
    const commandId = randomUUID();
    const answer = await run(client, "runs.send", { sessionId: id, text: "Go on", commandId });
    expect(answer.result).toMatchObject({ delivery: "prompt" });
    const events = eventsOf(t, id, head, answer.receipt.sequence);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "session.unarchived", "session.title-generated"]);
    expectOneTransaction(events);
    expect(events[4]).toMatchObject({ commandId, causationId: events[0]?.eventId });
  });

  it("owes its companions on a run the environment starts from its queue, in the host's transaction of that run.started", async () => {
    const held = gate();
    const t = await start({
      capabilities: { providerQueue: false, steering: false },
      script: async function* ({ input }) {
        if (input.prompt[0]?.text === "First") await held.opened;
        yield say("Read");
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id, "First");
    const queued = await run(client, "runs.send", { sessionId: id, text: "Second" });
    expect(queued.result).toMatchObject({ delivery: "queued", heldBy: "environment" });
    // Archived while its first run runs: the run the queue starts brings it back.
    await command(client, "sessions.archive", { sessionId: id });
    const head = t.env.log.head();
    held.open();

    await waitForEvent(t, id, head, "run.ended", first.runId);
    const started = (await vi.waitFor(() => {
      const found = eventsOf(t, id, head).find((event) => event.type === "run.started");
      expect(found).toBeDefined();
      return found;
    })) as EventEnvelope;
    const events = from(t, started, 5);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.delivered", "session.unarchived"]);
    expectOneTransaction(events);
    expect(events[0]).toMatchObject({ actor: "system:adapter-host", commandId: null, payload: { queuedMessageIds: [queued.result?.messageId] } });
    expect(events[4]?.causationId).toBe(started.eventId);
    expect((await get(client, id)).archivedAt).toBeNull();
  });

  it("owes its companions on a turn the provider opened on its own, adopted in the host's transaction of its run.started", async () => {
    const held = gate();
    const t = await start({
      capabilities: { steering: false },
      script: async function* ({ adopted }) {
        if (!adopted) await held.opened;
        yield say(adopted ? "Picked up" : "First done");
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id);
    await t.adapter.reached(1);
    const sent = await run(client, "runs.send", { sessionId: id, text: "Queued for later" });
    expect(sent.result).toMatchObject({ delivery: "queued", heldBy: "provider" });
    await command(client, "sessions.settle", { sessionId: id });
    const head = t.env.log.head();
    held.open();

    await waitForEvent(t, id, head, "run.ended", first.runId);
    const started = (await vi.waitFor(() => {
      const found = eventsOf(t, id, head).find((event) => event.type === "run.started");
      expect(found).toBeDefined();
      return found;
    })) as EventEnvelope;
    const events = from(t, started, 5);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.delivered", "session.unsettled"]);
    expectOneTransaction(events);
    expect(events[0]).toMatchObject({ actor: "adapter:fake", payload: { origin: "provider" } });
    expect(events[4]).toMatchObject({ causationId: started.eventId, payload: { reason: "activity" } });
    expect(await get(client, id)).toMatchObject({ settledAt: null, settledOverride: null });
  });
});

describe("a run's end", () => {
  /** Each way a run ends once it is live and its session snoozed: its script, what brings the end about, and who records it. */
  const endings: {
    readonly name: string;
    readonly script: (held: Gate) => Script;
    readonly finish: (client: WireClient, runId: string, held: Gate) => Promise<unknown>;
    readonly actor: string;
  }[] = [
    { name: "completed by its adapter", script: heldScript, finish: async (_client, _runId, held) => held.open(), actor: "adapter:fake" },
    {
      name: "failed, as its adapter reports it",
      script: () =>
        async function* () {
          yield say("Working");
          yield end("error", { error: { message: "The provider refused.", code: "refused" } });
        },
      finish: async () => undefined,
      actor: "adapter:fake",
    },
    {
      name: "failed, as the host records it when the stream throws",
      script: () =>
        async function* () {
          yield say("Working");
          throw new Error("The provider crashed.");
        },
      finish: async () => undefined,
      actor: "system:adapter-host",
    },
    { name: "interrupted", script: heldScript, finish: (client, runId) => run(client, "runs.interrupt", { runId }), actor: "adapter:fake" },
  ];

  it.each(endings)(
    "wakes its snoozed session when $name: session.unsnoozed, reason activity, in the transaction of run.ended, naming it as causation",
    async ({ script, finish, actor }) => {
      const held = gate();
      const snoozed = gate();
      const t = await start({
        script: async function* (controls) {
          // The session is snoozed while the run is live, before the run goes on to its end.
          await snoozed.opened;
          yield* script(held)(controls);
        },
      });
      const client = await t.client();
      const { id } = await create(client);
      const { runId } = await startRun(client, id);
      // On its adapter, past its skill set and instructions (#493, #496), so the run's own end is its adapter's.
      await t.adapter.reached(1);
      await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
      const head = t.env.log.head();
      snoozed.open();
      await finish(client, runId, held);

      const ended = await waitForEvent(t, id, head, "run.ended", runId);
      const events = from(t, ended, 2);
      expect(events.map((event) => event.type)).toEqual(["run.ended", "session.unsnoozed"]);
      expectOneTransaction(events);
      expect(events[0]?.actor).toBe(actor);
      expect(events[1]).toMatchObject({ causationId: ended.eventId, payload: { reason: "activity" } });
      expect((await get(client, id)).snoozedUntil).toBeNull();
    },
  );

  it("wakes a session snoozed when a restart cut its run: the recovery sweep's end owes the companion as every other end does", async () => {
    const dataDir = join(tempDir(), "data");
    const held = gate();
    onCleanup(() => held.open());
    const t = await startTestEnvironment({ dataDir, adapter: fakeAdapter({ script: heldScript(held) }) });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await waitForEvent(t, id, 0, "assistant.text", runId);
    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });

    // The environment dies with the run mid-flight: its end never reaches the log.
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await client.close();
    t.env.log.close();
    await t.close();
    loud.mockRestore();

    const again = await startTestEnvironment({ dataDir, clock: t.clock });
    onCleanup(() => again.close());
    const [ended, woken] = eventsOf(again, id, 0).slice(-2) as [EventEnvelope, EventEnvelope];
    expect(ended).toMatchObject({ type: "run.ended", actor: "system:adapter-host", payload: { runId, reason: "interrupted", cause: "restart" } });
    expect(woken).toMatchObject({ type: "session.unsnoozed", actor: "system:adapter-host", causationId: ended.eventId, correlationId: runId, payload: { reason: "activity" } });
    expectOneTransaction([ended, woken]);
    expect(await get(await again.client(), id)).toMatchObject({ snoozedUntil: null, activity: { state: "idle" } });
  });

  it("owes nothing on a session that is not snoozed, archived or settled though it be: its start brought it back", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await command(client, "sessions.archive", { sessionId: id });
    await command(client, "sessions.settle", { sessionId: id });
    const head = t.env.log.head();
    held.open();
    const ended = await waitForEvent(t, id, head, "run.ended", runId);
    expect(eventsOf(t, id, ended.sequence)).toEqual([]);
    expect(await get(client, id)).toMatchObject({ archivedAt: expect.any(String), settledBy: "user" });
  });

  it("owes nothing on a session deleted while its run was live: the disposed end is its last event", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await waitForEvent(t, id, 0, "assistant.text", runId);
    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
    await deleteSession(client, id);
    const events = eventsOf(t, id, 0);
    expect(events.at(-1)).toMatchObject({ type: "run.ended", payload: { runId, reason: "disposed" } });
    held.open();
  });
});

describe("the activity fields and auto-settle", () => {
  it("patch activity, lastActivityAt, accountId and model on the list from run.started and run.ended", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const list = await listStream(client, t.env.log.head());
    const { runId } = await startRun(client, id);
    const started = await list.next();
    expect(started.type).toBe("run.started");
    expect(patchOf(started)).toEqual({
      op: "set",
      sessionId: id,
      fields: { activity: { state: "running", since: at(0) }, lastActivityAt: at(0), accountId: "claude-max", model: "opus", runChoice: { model: "opus", effort: null } },
    });
    expect((await list.next()).type).toBe("session.title-generated");
    t.clock.advance(MINUTE);
    held.open();
    const ended = await list.next();
    expect(ended).toMatchObject({ type: "run.ended", payload: { runId } });
    expect(patchOf(ended)).toEqual({ op: "set", sessionId: id, fields: { activity: { state: "idle", since: at(MINUTE) }, lastActivityAt: at(MINUTE) } });
  });

  it("leaves out of auto-settle a session whose real run is starting, then running, and counts from its end", async () => {
    const begun = gate();
    const held = gate();
    const t = await start({
      script: async function* () {
        await begun.opened;
        yield say("Working");
        await held.opened;
        yield end();
      },
    });
    let client = await t.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": { amount: 1, unit: "days" } });
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    const state = () => [...t.runs.runs()].find((record) => record.id === runId)?.state;

    // Starting: the host has the run, and the adapter has reported nothing yet.
    expect(state()).toBe("starting");
    client = await pass(t, client, 3 * DAY);
    expect(await get(client, id)).toMatchObject({ settledAt: null, activity: { state: "running", since: at(0) } });

    // Running: its first event is in.
    begun.open();
    await vi.waitFor(() => expect(state()).toBe("running"));
    client = await pass(t, client, 3 * DAY);
    expect((await get(client, id)).settledAt).toBeNull();

    held.open();
    await vi.waitFor(async () => expect((await get(client, id)).activity).toEqual({ state: "idle", since: at(6 * DAY) }));
    client = await pass(t, client, DAY);
    expect((await get(client, id)).settledAt).toBeNull();
    client = await pass(t, client, SWEEP_EVERY);
    expect((await get(client, id)).settledBy).toBe("auto-idle");
  });
});

describe("the generated title", () => {
  it("is set once from the first user message: its first non-empty line, white space collapsed, cut at a word with an ellipsis, source prompt, in the message's transaction", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const list = await listStream(client, t.env.log.head());
    const head = t.env.log.head();
    const line = `Fix   the\treceipts ${"and the sweep ".repeat(8)}`;

    const first = await startRun(client, id, `\n   \n  ${line}\nThen the rest.`);

    const events = eventsOf(t, id, head, first.sequence);
    const titled = events.at(-1) as EventEnvelope;
    // The line as the rule leaves it, written out: its white space collapsed and its ends trimmed, 128 characters, so
    // cut at the last space within 79 and ended with an ellipsis, 77 characters in all.
    const expected = `Fix the receipts ${"and the sweep ".repeat(4)}and…`;
    expect(titled).toMatchObject({ type: "session.title-generated", payload: { title: expected, source: "prompt" } });
    expect(titled.causationId).toBe(events.find((event) => event.type === "message.sent")?.eventId);
    expectOneTransaction(events);
    await list.next();
    expect(patchOf(await list.next())).toEqual({ op: "set", sessionId: id, fields: { title: expected, titleSource: "generated" } });
    expect(await get(client, id)).toMatchObject({ title: expected, titleSource: "generated" });

    // A later message generates nothing.
    await waitForEvent(t, id, head, "run.ended", first.runId);
    const later = t.env.log.head();
    const second = await startRun(client, id, "Something else entirely");
    expect(eventsOf(t, id, later, second.sequence).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent"]);
    expect((await get(client, id)).title).toBe(expected);
  });

  it("waits for a message with a non-empty line", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const head = t.env.log.head();
    const first = await startRun(client, id, "  \n ");
    expect(eventsOf(t, id, head, first.sequence).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent"]);
    await waitForEvent(t, id, head, "run.ended", first.runId);
    await startRun(client, id, "Now a real one");
    expect(await get(client, id)).toMatchObject({ title: "Now a real one", titleSource: "generated" });
  });

  it("is kept under a user title, which it never replaces, and sessions.rename to null reverts to it", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { title: "Mine" });
    const { runId } = await startRun(client, id, "Fix the receipts");
    await waitForEvent(t, id, 0, "run.ended", runId);
    expect(await get(client, id)).toMatchObject({ title: "Mine", titleSource: "user" });

    const list = await listStream(client, t.env.log.head());
    await rename(client, id, null);
    expect(patchOf(await list.next())).toMatchObject({ fields: { title: "Fix the receipts", titleSource: "generated" } });
    expect(await get(client, id)).toMatchObject({ title: "Fix the receipts", titleSource: "generated" });
    await rename(client, id, "Mine again");
    expect(await get(client, id)).toMatchObject({ title: "Mine again", titleSource: "user" });
  });

  it("reverts to New session on sessions.rename to null when none has been generated", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { title: "Mine" });
    await rename(client, id, null);
    expect(await get(client, id)).toMatchObject({ title: "New session", titleSource: "default" });
  });
});

describe("a provider's title", () => {
  it("is read after a run ends and recorded as the generated title, source provider, by the adapter, naming the run's end as causation", async () => {
    const held = gate();
    const t = await start({ title: "Receipts retention sweep", script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, "Fix the receipts");
    expect(await get(client, id)).toMatchObject({ title: "Fix the receipts", titleSource: "generated" });
    expect(t.adapter.titleReads).toEqual([]);
    held.open();

    const ended = await waitForEvent(t, id, 0, "run.ended", runId);
    const titled = await waitForEvent(t, id, ended.sequence, "session.title-generated");
    expect(titled).toMatchObject({ actor: "adapter:fake", causationId: ended.eventId, correlationId: runId, payload: { title: "Receipts retention sweep", source: "provider" } });
    expect(t.adapter.titleReads).toEqual([id]);
    expect(await get(client, id)).toMatchObject({ title: "Receipts retention sweep", titleSource: "generated" });

    // The same title again changes nothing.
    const again = await startRun(client, id, "More");
    await waitForEvent(t, id, again.sequence, "run.ended", again.runId);
    await vi.waitFor(() => expect(t.adapter.titleReads).toEqual([id, id]));
    expect(eventsOf(t, id, again.sequence).filter((event) => event.type === "session.title-generated")).toEqual([]);
  });

  it("is not recorded while the user has set a title, which always wins", async () => {
    const t = await start({ title: "Receipts retention sweep" });
    const client = await t.client();
    const { id } = await create(client);
    await rename(client, id, "Mine");
    const { runId, sequence } = await startRun(client, id, "Fix the receipts");
    await waitForEvent(t, id, sequence, "run.ended", runId);
    await vi.waitFor(() => expect(t.adapter.titleReads).toEqual([id]));
    expect(eventsOf(t, id, sequence).filter((event) => event.type === "session.title-generated")).toEqual([]);
    expect(await get(client, id)).toMatchObject({ title: "Mine", titleSource: "user" });
  });

  it("records nothing when the provider has none, when its read fails, or when the adapter does not declare titleRead", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    for (const options of [{ title: null }, { title: { fails: "The store is locked." } }, { title: "Unread", capabilities: { titleRead: false } }] as FakeAdapterOptions[]) {
      const t = await start(options);
      const client = await t.client();
      const { id } = await create(client);
      const { runId, sequence } = await startRun(client, id, "Fix the receipts");
      await waitForEvent(t, id, sequence, "run.ended", runId);
      // A second run after the first, so any read the first end set off has had its turn.
      const second = await startRun(client, id, "Again");
      await waitForEvent(t, id, second.sequence, "run.ended", second.runId);
      expect(eventsOf(t, id, sequence).filter((event) => event.type === "session.title-generated"), JSON.stringify(options)).toEqual([]);
      expect(t.adapter.titleReads).toEqual(options.capabilities?.titleRead === false ? [] : [id, id]);
      expect((await get(client, id)).title).toBe("Fix the receipts");
    }
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("provider's title"), expect.any(Error));
  });
});

describe("the mirror", () => {
  it("writes a user title to the provider after commit when the adapter declares titleWrite, and reads nothing back", async () => {
    const t = await start({ titleWrite: true, title: "Never read" });
    const client = await t.client();
    const { id } = await create(client);
    const { runId, sequence } = await startRun(client, id);
    await waitForEvent(t, id, sequence, "run.ended", runId);
    await vi.waitFor(() => expect(t.adapter.titleReads).toEqual([id]));
    const answer = await rename(client, id, "  Mine ");
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    await vi.waitFor(() => expect(t.adapter.mirroredTitles).toEqual([{ sessionId: id, title: "Mine" }]));
    // Only the read after the run's end: the mirror reads nothing back.
    expect(t.adapter.titleReads).toEqual([id]);

    // A rename to null, a rename that changes nothing and a refused rename mirror nothing.
    await rename(client, id, null);
    await rename(client, id, null);
    await deleteSession(client, id);
    expect((await rename(client, id, "Gone")).receipt).toMatchObject({ status: "rejected" });
    expect(t.adapter.mirroredTitles).toEqual([{ sessionId: id, title: "Mine" }]);
    expect(t.adapter.titleReads).toEqual([id]);
  });

  it("writes nothing for a session that has never run: the provider has no session to title yet", async () => {
    const t = await start({ titleWrite: true });
    const client = await t.client();
    const { id } = await create(client);
    await rename(client, id, "Mine");
    const { runId, sequence } = await startRun(client, id);
    await waitForEvent(t, id, sequence, "run.ended", runId);
    expect(t.adapter.mirroredTitles).toEqual([]);
    await rename(client, id, "Mine, once it ran");
    await vi.waitFor(() => expect(t.adapter.mirroredTitles).toEqual([{ sessionId: id, title: "Mine, once it ran" }]));
  });

  it("writes nothing when the adapter does not declare titleWrite, though it has the method", async () => {
    const t = await start({ titleWrite: true, capabilities: { titleWrite: false } });
    const client = await t.client();
    const { id } = await create(client);
    const { runId, sequence } = await startRun(client, id);
    await waitForEvent(t, id, sequence, "run.ended", runId);
    await rename(client, id, "Mine");
    expect(t.adapter.mirroredTitles).toEqual([]);
  });

  it("is best effort: a write that fails is logged, and the title stands", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const t = await start({ titleWrite: { fails: "The provider is offline." } });
    const client = await t.client();
    const { id } = await create(client);
    const { runId, sequence } = await startRun(client, id);
    await waitForEvent(t, id, sequence, "run.ended", runId);
    expect((await rename(client, id, "Mine")).result?.summary).toMatchObject({ title: "Mine", titleSource: "user" });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Mirroring the title of session ${id}`), expect.any(Error)));
    expect(t.adapter.mirroredTitles).toEqual([{ sessionId: id, title: "Mine" }]);
    expect(await get(client, id)).toMatchObject({ title: "Mine" });
  });
});

describe("the provider's tag field", () => {
  it("is in no member of the adapter contract, so nothing can write it", () => {
    type Members = keyof Adapter | keyof AdapterRun | keyof AdapterDescriptor;
    type TagMembers = Extract<Members, `${string}${"tag" | "Tag"}${string}`>;
    const none: [TagMembers] extends [never] ? true : false = true;
    expect(none).toBe(true);
  });

  it("is reached by no organisation command: of all a client files, tags and titles, only a user title goes to the provider", async () => {
    const t = await start({ titleWrite: true, title: "Provider's own" });
    const client = await t.client();
    const { id: groupId } = await createGroup(client, { name: "Meadowstudios" });
    const { id } = await create(client, { title: "Mine", tags: ["wip"] });
    const { runId, sequence } = await startRun(client, id);
    await waitForEvent(t, id, sequence, "run.ended", runId);
    await command(client, "sessions.tag", { sessionId: id, tag: "review" });
    await command(client, "sessions.untag", { sessionId: id, tag: "wip" });
    await command(client, "sessions.archive", { sessionId: id });
    await command(client, "sessions.unarchive", { sessionId: id });
    await command(client, "sessions.pin", { sessionId: id });
    await command(client, "sessions.unpin", { sessionId: id });
    await command(client, "sessions.setGroup", { sessionId: id, groupId });
    await command(client, "sessions.settle", { sessionId: id });
    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
    await rename(client, id, "Renamed");
    await rename(client, id, null);
    await deleteSession(client, id);
    await command(client, "sessions.restore", { sessionId: id });
    await vi.waitFor(() => expect(t.adapter.mirroredTitles).toEqual([{ sessionId: id, title: "Renamed" }]));
  });
});
