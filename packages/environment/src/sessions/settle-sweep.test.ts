import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EventEnvelope, SettingsPatch } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, deleteSession, get, listStream, patchOf, reduce } from "../../test/sessions.js";
import { DAY, MINUTE, SWEEP_EVERY, SYNTHETIC_ACTOR, eventsAfter, pass, pullRequest, seed, updateSettings } from "../../test/shelf.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The auto-settle and snooze-expiry sweep through the primary seam
 * (session-state spec, "Auto-settle: rules and settings" and "Snooze
 * expiry"), under the helper's manual clock: it runs at startup, every five
 * minutes and when either auto-settle setting changes. The run, prompt and
 * pull-request events other workstreams will append are seeded as
 * synthetic events (`test/shelf.ts`). Days pass with the client's socket
 * closed (`pass`), so no socket is pinged through them.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: { dataDir?: string; clockStart?: string } = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({
    ...(options.dataDir !== undefined && { dataDir: options.dataDir }),
    ...(options.clockStart !== undefined && { clock: manualClock(options.clockStart) }),
  });
  onCleanup(() => t.close());
  return t;
};

/** The instant `ms` after `from` (the manual clock's start unless given). */
const at = (ms: number, from = MANUAL_CLOCK_START): string => new Date(Date.parse(from) + ms).toISOString();

/** The sweep's actor, as the log stores it. */
const SWEEP_ACTOR = "system:settle-sweep";

/** A client with settings applied, and a session created now. */
const setUp = async (t: TestEnvironment, settings: SettingsPatch = {}): Promise<{ client: WireClient; id: string }> => {
  const client = await t.client();
  await updateSettings(client, settings);
  const { id } = await create(client);
  return { client, id };
};

const oneDay = { "sessions.autoSettleAfterIdle": { amount: 1, unit: "days" } } as const;

describe("the idle rule", () => {
  it("settles a session quiet for fourteen days, by the preset, at the first sweep after its span has passed: auto-idle, by the sweep", async () => {
    const t = await start();
    const setup = await setUp(t);
    const client = await pass(t, setup.client, 14 * DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    const list = await listStream(client, t.env.log.head());

    t.clock.advance(SWEEP_EVERY);

    const event = await list.next();
    expect(event).toMatchObject({
      type: "session.settled",
      streamId: setup.id,
      commandId: null,
      actor: { kind: "system", id: "settle-sweep" },
      occurredAt: at(14 * DAY + SWEEP_EVERY),
      payload: { settledAt: at(14 * DAY + SWEEP_EVERY), by: "auto-idle" },
    });
    expect(patchOf(event)).toMatchObject({ fields: { settledAt: at(14 * DAY + SWEEP_EVERY), settledBy: "auto-idle", settledOverride: "settled" } });
    expect(await get(client, setup.id)).toMatchObject({ settledAt: at(14 * DAY + SWEEP_EVERY), settledBy: "auto-idle", settledOverride: "settled" });
  });

  it("unpins and clears the active key of a session it settles, in one transaction, the companions naming the settle as their causation", async () => {
    const t = await start();
    const { client, id } = await setUp(t, oneDay);
    await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" });
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    const head = t.env.log.head();

    const again = await pass(t, client, DAY + SWEEP_EVERY);

    const events = eventsAfter(t, head);
    expect(events.map((event) => [event.type, event.actor, event.occurredAt, event.commandId])).toEqual([
      ["session.settled", SWEEP_ACTOR, at(DAY + SWEEP_EVERY), null],
      ["session.unpinned", SWEEP_ACTOR, at(DAY + SWEEP_EVERY), null],
      ["session.active-reordered", SWEEP_ACTOR, at(DAY + SWEEP_EVERY), null],
    ]);
    const first = events[0]?.sequence ?? 0;
    expect(events.map((event) => event.sequence)).toEqual([first, first + 1, first + 2]);
    expect(events.map((event) => event.causationId)).toEqual([null, events[0]?.eventId, events[0]?.eventId]);
    expect(await get(again, id)).toMatchObject({ settledBy: "auto-idle", pinnedAt: null, pinOrderKey: null, activeOrderKey: null });
  });

  it("counts weeks as seven days", async () => {
    const t = await start();
    const setup = await setUp(t, { "sessions.autoSettleAfterIdle": { amount: 2, unit: "weeks" } });
    const client = await pass(t, setup.client, 14 * DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(SWEEP_EVERY);
    expect((await get(client, setup.id)).settledBy).toBe("auto-idle");
  });

  it("counts months as calendar months: from January 31st a month ends on February 28th, not after 30 or 31 days", async () => {
    const t = await start({ clockStart: "2026-01-31T12:00:00.000Z" });
    const setup = await setUp(t, { "sessions.autoSettleAfterIdle": { amount: 1, unit: "months" } });
    const client = await pass(t, setup.client, 28 * DAY);
    expect(t.clock.now().toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(SWEEP_EVERY);
    expect(await get(client, setup.id)).toMatchObject({ settledAt: "2026-02-28T12:05:00.000Z", settledBy: "auto-idle" });
  });

  it("counts a month from January 31st of a leap year to February 29th", async () => {
    const t = await start({ clockStart: "2028-01-31T00:00:00.000Z" });
    const setup = await setUp(t, { "sessions.autoSettleAfterIdle": { amount: 1, unit: "months" } });
    const client = await pass(t, setup.client, 29 * DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(SWEEP_EVERY);
    expect((await get(client, setup.id)).settledAt).toBe("2028-02-29T00:05:00.000Z");
  });

  it("settles nothing with the rule off", async () => {
    const t = await start();
    const setup = await setUp(t, { "sessions.autoSettleAfterIdle": null });
    const client = await pass(t, setup.client, 20 * DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
  });

  it("counts from the last activity: a run's end, seeded until the adapter appends it", async () => {
    const t = await start();
    const setup = await setUp(t, oneDay);
    let client = await pass(t, setup.client, 12 * 60 * MINUTE);
    seed(t, setup.id, "run.started");
    t.clock.advance(MINUTE);
    seed(t, setup.id, "run.ended");
    expect(await get(client, setup.id)).toMatchObject({ lastActivityAt: at(12 * 60 * MINUTE + MINUTE), activity: { state: "idle" } });
    client = await pass(t, client, DAY - SWEEP_EVERY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(2 * SWEEP_EVERY);
    expect((await get(client, setup.id)).settledBy).toBe("auto-idle");
  });

  it("gives a session snoozed until a time a full span from then: woken expired at the first sweep after, settled a span later", async () => {
    const t = await start();
    const setup = await setUp(t, oneDay);
    await command(setup.client, "sessions.snooze", { sessionId: setup.id, until: at(3 * DAY) });
    let client = await pass(t, setup.client, 3 * DAY);
    expect(await get(client, setup.id)).toMatchObject({ snoozedUntil: null, settledAt: null });
    client = await pass(t, client, DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(SWEEP_EVERY);
    expect(await get(client, setup.id)).toMatchObject({ settledAt: at(4 * DAY + SWEEP_EVERY), settledBy: "auto-idle" });
  });
});

describe("the candidates", () => {
  it("leave out a run starting or running, a run parked on a prompt, an open prompt, an archived and a snoozed session", async () => {
    const t = await start();
    let client = await t.client();
    await updateSettings(client, oneDay);
    const running = (await create(client)).id;
    seed(t, running, "run.started");
    const parked = (await create(client)).id;
    seed(t, parked, "run.started");
    seed(t, parked, "prompt.opened");
    const archived = (await create(client)).id;
    await command(client, "sessions.archive", { sessionId: archived });
    const snoozed = (await create(client)).id;
    await command(client, "sessions.snooze", { sessionId: snoozed, until: at(25 * DAY) });
    const idle = (await create(client)).id;
    expect(await get(client, running)).toMatchObject({ activity: { state: "running" }, lastActivityAt: at(0) });
    expect(await get(client, parked)).toMatchObject({ activity: { state: "parked" }, parkedPromptCount: 1 });

    client = await pass(t, client, 20 * DAY);

    for (const id of [running, parked, archived, snoozed]) expect((await get(client, id)).settledAt, id).toBeNull();
    expect((await get(client, idle)).settledBy).toBe("auto-idle");

    // Answered, the prompt is activity and the run goes on; a day after the run ends, the session settles.
    seed(t, parked, "prompt.answered");
    expect(await get(client, parked)).toMatchObject({ activity: { state: "running" }, parkedPromptCount: 0, lastActivityAt: at(20 * DAY) });
    seed(t, parked, "run.ended");
    client = await pass(t, client, DAY + SWEEP_EVERY);
    expect((await get(client, parked)).settledBy).toBe("auto-idle");
    expect((await get(client, running)).settledAt).toBeNull();
  });

  it("leave out a deleted session, and wake no deleted session's snooze; restored in its grace period, it is judged again", async () => {
    const t = await start();
    const setup = await setUp(t, oneDay);
    const snoozed = (await create(setup.client)).id;
    await command(setup.client, "sessions.snooze", { sessionId: snoozed, until: at(DAY) });
    await deleteSession(setup.client, setup.id);
    await deleteSession(setup.client, snoozed);
    const head = t.env.log.head();

    let client = await pass(t, setup.client, 3 * DAY);

    expect(eventsAfter(t, head)).toEqual([]);
    await command(client, "sessions.restore", { sessionId: setup.id });
    await command(client, "sessions.restore", { sessionId: snoozed });
    client = await pass(t, client, SWEEP_EVERY);
    expect((await get(client, setup.id)).settledBy).toBe("auto-idle");
    expect(await get(client, snoozed)).toMatchObject({ snoozedUntil: null, settledBy: "auto-idle" });
    expect(eventsAfter(t, head).filter((event) => event.streamId === snoozed).map((event) => [event.type, event.payload])).toEqual([
      ["session.restored", {}],
      ["session.unsnoozed", { reason: "expired" }],
      ["session.settled", { settledAt: at(3 * DAY + SWEEP_EVERY), by: "auto-idle" }],
    ]);
  });

  it("leave out a session a user unsettled: the override holds it active until activity clears it", async () => {
    const t = await start();
    const setup = await setUp(t, oneDay);
    await command(setup.client, "sessions.unsettle", { sessionId: setup.id });
    let client = await pass(t, setup.client, 10 * DAY);
    expect(await get(client, setup.id)).toMatchObject({ settledAt: null, settledOverride: "active" });
    // Settled by hand and unsettled again, it still stays.
    await command(client, "sessions.settle", { sessionId: setup.id });
    await command(client, "sessions.unsettle", { sessionId: setup.id });
    client = await pass(t, client, 10 * DAY);
    expect(await get(client, setup.id)).toMatchObject({ settledAt: null, settledOverride: "active" });
  });
});

describe("the merge rule", () => {
  const off = { "sessions.autoSettleAfterIdle": null } as const;

  it("with the setting on, settles a session whose pull request merged at or after its anchor, auto-merge, at the next sweep", async () => {
    const t = await start();
    const { client, id } = await setUp(t, { ...off, "sessions.autoSettleOnMerge": true });
    seed(t, id, "session.pull-request-synced", pullRequest("open", at(0)));
    t.clock.advance(SWEEP_EVERY);
    expect((await get(client, id)).settledAt).toBeNull();
    t.clock.advance(MINUTE);
    seed(t, id, "session.pull-request-synced", pullRequest("merged", at(SWEEP_EVERY + MINUTE)));
    expect((await get(client, id)).pullRequests).toEqual([pullRequest("merged", at(SWEEP_EVERY + MINUTE))]);
    t.clock.advance(SWEEP_EVERY - MINUTE);
    expect(await get(client, id)).toMatchObject({ settledAt: at(2 * SWEEP_EVERY), settledBy: "auto-merge" });
  });

  it("settles nothing on a pull request closed without merging", async () => {
    const t = await start();
    const setup = await setUp(t, { ...off, "sessions.autoSettleOnMerge": true });
    seed(t, setup.id, "session.pull-request-synced", pullRequest("closed", at(0)));
    const client = await pass(t, setup.client, DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
  });

  it("settles nothing with the setting off", async () => {
    const t = await start();
    const setup = await setUp(t, off);
    seed(t, setup.id, "session.pull-request-synced", pullRequest("merged", at(0)));
    const client = await pass(t, setup.client, DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
  });

  it("settles nothing on a merge before the session's last activity", async () => {
    const t = await start();
    const setup = await setUp(t, { ...off, "sessions.autoSettleOnMerge": true });
    t.clock.advance(MINUTE);
    seed(t, setup.id, "session.pull-request-synced", pullRequest("merged", at(0)));
    seed(t, setup.id, "run.started");
    seed(t, setup.id, "run.ended");
    const client = await pass(t, setup.client, DAY);
    expect((await get(client, setup.id)).settledAt).toBeNull();
  });
});

describe("when the sweep runs", () => {
  it("runs at startup: a session past its span on a restarted environment settles before the first five minutes", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir });
    const { id } = await setUp(first);
    await first.close();

    const second = await start({ dataDir, clockStart: at(15 * DAY) });
    const client = await second.client();
    expect(await get(client, id)).toMatchObject({ settledAt: at(15 * DAY), settledBy: "auto-idle" });
  });

  it("runs every five minutes and not between", async () => {
    const t = await start();
    const setup = await setUp(t, oneDay);
    const client = await pass(t, setup.client, DAY + MINUTE);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(SWEEP_EVERY - MINUTE - 1);
    expect((await get(client, setup.id)).settledAt).toBeNull();
    t.clock.advance(1);
    expect((await get(client, setup.id)).settledAt).toBe(at(DAY + SWEEP_EVERY));
  });

  it("runs when either setting changes, before the change is answered", async () => {
    const t = await start();
    const setup = await setUp(t);
    const client = await pass(t, setup.client, 10 * DAY);
    const head = t.env.log.head();

    const answer = await updateSettings(client, { "sessions.autoSettleAfterIdle": { amount: 1, unit: "weeks" } });

    expect(answer.receipt.sequence).toBe(head + 1);
    expect(eventsAfter(t, head).map((event) => [event.type, event.actor])).toEqual([
      ["settings.updated", `client_session:${client.hello.clientSessionId}`],
      ["session.settled", SWEEP_ACTOR],
    ]);
    expect(await get(client, setup.id)).toMatchObject({ settledAt: at(10 * DAY), settledBy: "auto-idle" });

    const merged = (await create(client)).id;
    seed(t, merged, "session.pull-request-synced", pullRequest("merged", at(10 * DAY)));
    const before = t.env.log.head();
    await updateSettings(client, { "sessions.autoSettleOnMerge": true });
    expect(eventsAfter(t, before).map((event) => event.type)).toEqual(["settings.updated", "session.settled"]);
    expect((await get(client, merged)).settledBy).toBe("auto-merge");
  });

  it("never reopens a settled session when a rule changes", async () => {
    const t = await start();
    const setup = await setUp(t, oneDay);
    const client = await pass(t, setup.client, 2 * DAY);
    const settled = await get(client, setup.id);
    expect(settled.settledBy).toBe("auto-idle");
    for (const values of [
      { "sessions.autoSettleAfterIdle": { amount: 3, unit: "months" } },
      { "sessions.autoSettleAfterIdle": null },
      { "sessions.autoSettleOnMerge": true },
      { "sessions.autoSettleOnMerge": false },
    ] as const) {
      await updateSettings(client, values);
      t.clock.advance(SWEEP_EVERY);
    }
    expect(await get(client, setup.id)).toEqual(settled);
  });
});

describe("snooze expiry", () => {
  it("wakes every session whose snoozedUntil has passed at the next sweep, archived ones too: session.unsnoozed, reason expired, clearing it", async () => {
    const t = await start();
    const { client, id } = await setUp(t, { "sessions.autoSettleAfterIdle": null });
    const other = (await create(client)).id;
    await command(client, "sessions.snooze", { sessionId: id, until: at(2 * MINUTE) });
    await command(client, "sessions.snooze", { sessionId: other, until: at(3 * MINUTE) });
    await command(client, "sessions.archive", { sessionId: other });
    const list = await listStream(client, t.env.log.head());

    t.clock.advance(SWEEP_EVERY - 1);
    expect((await get(client, id)).snoozedUntil).toBe(at(2 * MINUTE));
    t.clock.advance(1);

    const events = [await list.next(), await list.next()];
    expect(events.map((event) => [event.streamId, event.type, event.payload, event.actor, event.occurredAt])).toEqual(
      expect.arrayContaining([
        [id, "session.unsnoozed", { reason: "expired" }, { kind: "system", id: "settle-sweep" }, at(SWEEP_EVERY)],
        [other, "session.unsnoozed", { reason: "expired" }, { kind: "system", id: "settle-sweep" }, at(SWEEP_EVERY)],
      ]),
    );
    for (const event of events) expect(patchOf(event)).toMatchObject({ fields: { snoozedUntil: null, snoozedAt: null } });
    expect(await get(client, id)).toMatchObject({ snoozedUntil: null, snoozedAt: null });
  });

  it("leaves a snooze still to come", async () => {
    const t = await start();
    const setup = await setUp(t);
    await command(setup.client, "sessions.snooze", { sessionId: setup.id, until: at(DAY) });
    const client = await pass(t, setup.client, DAY - 1);
    expect((await get(client, setup.id)).snoozedUntil).toBe(at(DAY));
  });
});

describe("the sweep's work as clients see it", () => {
  it("reaches a client replaying from its cursor as patches that reduce to the list, and a rebuild gives the same snapshot", async () => {
    const t = await start();
    const first = await t.client();
    await updateSettings(first, oneDay);
    const { id } = await create(first);
    await command(first, "sessions.pin", { sessionId: id });
    await command(first, "sessions.snooze", { sessionId: id, until: at(2 * MINUTE) });
    const cached = await first.request("sessions.list", {});

    const second = await pass(t, first, DAY + 2 * MINUTE + SWEEP_EVERY);

    // The expiry at five minutes, then the settle and its unpin a day after the snooze ended.
    const { subscription } = await second.subscribe("sessions.subscribe", { afterSequence: cached.sequence });
    const events: EventEnvelope[] = [];
    for (let i = 0; i < 3; i++) {
      const frame = await second.next((f) => f.type === "event" && f.subscription === subscription);
      if (frame.type === "event") events.push(frame.event);
    }
    expect(events.map((event) => event.type)).toEqual(["session.unsnoozed", "session.settled", "session.unpinned"]);
    const listed = await second.request("sessions.list", {});
    expect(reduce({ sessions: cached.sessions, groups: [] }, events)).toEqual(reduce({ sessions: listed.sessions, groups: [] }, []));

    const read = async () => {
      const sub = await second.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
      const frame = await second.next((f) => f.type === "snapshot" && f.subscription === sub.subscription);
      second.send({ type: "unsubscribe", subscription: sub.subscription });
      return frame.type === "snapshot" ? frame.payload : undefined;
    };
    const before = await read();
    await second.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await read()).toEqual(before);
  });

  it("leaves a seeded event's actor the adapter's", async () => {
    const t = await start();
    const { id } = await setUp(t);
    const [started] = seed(t, id, "run.started");
    expect(started?.actor).toBe(SYNTHETIC_ACTOR);
  });
});
