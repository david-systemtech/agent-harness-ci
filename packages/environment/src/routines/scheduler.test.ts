import type { RoutineDefinitionInput } from "@agent-harness/contracts";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type Gate, type Script } from "../../test/fake-adapter.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, ranNow, routineCommand, runNow, untilRoutineEvent, untilSettled, untilStarted, written } from "../../test/routines.js";
import { makeDirectory, scriptedResolver } from "../../test/workspaces.js";

/**
 * The scheduler (routines spec, "The scheduler"; #527) through the primary
 * seam: an in-process environment and a real client under the manual clock,
 * moved on minute by minute and jumped without its timers running, the
 * scripted fake provider with a quick run and a long one, and restarts on one
 * data directory. What is asserted is what a client sees: the routine's
 * records, its history and `routines.list`.
 */

const { onCleanup, tempDir } = useCleanups();

/** The zone the test environment and its routines run in: the manual clock's start, 00:00 UTC, is 08:00 there, a Thursday. */
const ZONE = "Asia/Manila";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: ZONE, name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it, in the environment's zone. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ timezone: ZONE, ...overrides });

/** Moves the clock on a minute at a time, `minutes` times, each minute's timers running as it passes. */
const walk = (t: TestEnvironment, minutes: number): void => {
  for (let minute = 0; minute < minutes; minute += 1) t.clock.advance(MINUTE);
};

/** The routine's firings and skips as its stream records them, in order: each record's type and time beside its payload's fields. */
const records = (t: TestEnvironment, routineId: string): Readonly<Record<string, unknown>>[] =>
  t.env.log
    .readStream({ kind: "routine", id: routineId })
    .filter((event) => event.type === "routine.firing-started" || event.type === "routine.skipped")
    .map((event) => ({ type: event.type, occurredAt: event.occurredAt, ...event.payload }));

/** The routine's next record, a firing's start or a skip, once it is on the log. */
const untilRecorded = (t: TestEnvironment, routineId: string) =>
  untilRoutineEvent(t, routineId, (event) => event.type === "routine.firing-started" || event.type === "routine.skipped");

/** A gate opened when the test ends, so a run or a start it holds never outlives it. */
const heldGate = (): Gate => {
  const held = gate();
  onCleanup(() => held.open());
  return held;
};

/** Runs that each wait, after saying they are working, until the test lets their session's run end. */
const heldRuns = () => {
  const gates = new Map<string, Gate>();
  const gateOf = (sessionId: string): Gate => {
    const held = gates.get(sessionId) ?? heldGate();
    gates.set(sessionId, held);
    return held;
  };
  const script: Script = async function* ({ input }) {
    yield say("Working");
    await gateOf(input.sessionId).opened;
    yield say("Done.");
    yield end();
  };
  return { script, end: (sessionId: string) => gateOf(sessionId).open() };
};

/** The record of the routine's due time `at`, once it is on the log: its firing's start or its skip. */
const untilDue = (t: TestEnvironment, routineId: string, at: string) =>
  untilRoutineEvent(t, routineId, (event) => (event.type === "routine.firing-started" || event.type === "routine.skipped") && event.payload["dueAt"] === at);

/** Each record as its kind, due time and, for a skip, its reason and count. */
const summary = (t: TestEnvironment, routineId: string) =>
  records(t, routineId).map((record) =>
    record.type === "routine.skipped" ? ["skip", record["dueAt"], record["reason"], record["count"]] : ["firing", record["dueAt"], record["trigger"], record["count"]],
  );

describe("the scheduler", () => {
  it("fires a routine at its due time with no client connected, trigger schedule, and lists the due time after it", async () => {
    const t = await start();
    const client = await t.client();
    const { state, nextDueAt, definition } = await created(client, routine({ name: "Morning digest", schedule: { kind: "daily", at: "09:00" } }));
    expect(definition.enabled).toBe(true);
    expect(state.handledThrough).toBe(MANUAL_CLOCK_START);
    // 09:00 in Manila is 01:00 UTC.
    expect(nextDueAt).toBe("2026-09-24T01:00:00.000Z");
    await client.close();

    walk(t, 59);
    expect(records(t, state.id)).toEqual([]);
    walk(t, 1);
    const started = await untilRecorded(t, state.id);
    expect(started).toMatchObject({
      type: "routine.firing-started",
      actor: `routine:${state.id}`,
      occurredAt: "2026-09-24T01:00:00.000Z",
      payload: { trigger: "schedule", dueAt: "2026-09-24T01:00:00.000Z", count: 1, requestedBy: null },
    });
    await untilSettled(t, state.id, started.payload["firingId"] as string);

    const again = await t.client();
    expect(await listed(again, state.id)).toMatchObject({
      state: { handledThrough: "2026-09-24T01:00:00.000Z", liveFiring: null, lastOutcome: { kind: "firing", outcome: "succeeded" } },
      nextDueAt: "2026-09-25T01:00:00.000Z",
    });
  });

  it("fires each schedule kind at its due time in the routine's zone, once each, walking the clock a minute at a time", async () => {
    const t = await start();
    const client = await t.client();
    // From Thursday 2026-09-24 08:00 in Manila (UTC+8), each kind's due times until 12:00 there, in UTC.
    const kinds: { readonly schedule: RoutineDefinitionInput["schedule"]; readonly due: readonly string[] }[] = [
      { schedule: { kind: "hourly", minute: 30 }, due: ["2026-09-24T00:30:00.000Z", "2026-09-24T01:30:00.000Z", "2026-09-24T02:30:00.000Z", "2026-09-24T03:30:00.000Z"] },
      { schedule: { kind: "days", days: ["thursday", "saturday"], at: "08:45" }, due: ["2026-09-24T00:45:00.000Z"] },
      { schedule: { kind: "daily", at: "09:15" }, due: ["2026-09-24T01:15:00.000Z"] },
      { schedule: { kind: "cron", expression: "20 9 * * thu" }, due: ["2026-09-24T01:20:00.000Z"] },
      { schedule: { kind: "weekdays", at: "10:00" }, due: ["2026-09-24T02:00:00.000Z"] },
      { schedule: { kind: "weekly", day: "thursday", at: "11:00" }, due: ["2026-09-24T03:00:00.000Z"] },
      { schedule: { kind: "monthly", day: 24, at: "12:00" }, due: ["2026-09-24T04:00:00.000Z"] },
    ];
    const ids: string[] = [];
    for (const { schedule, due } of kinds) {
      const made = await created(client, routine({ name: `A ${schedule.kind} routine`, schedule }));
      expect(made.nextDueAt).toBe(due[0]);
      ids.push(made.state.id);
    }
    await client.close();

    // Every due time in order, each walked to a minute at a time and its firing followed to its end before the next.
    const timeline = kinds.flatMap(({ due }, index) => due.map((at) => ({ id: ids[index] ?? "", at }))).sort((a, b) => a.at.localeCompare(b.at));
    for (const { id, at } of timeline) {
      const before = records(t, id).length;
      walk(t, (Date.parse(at) - t.clock.now().getTime()) / MINUTE - 1);
      expect(records(t, id)).toHaveLength(before);
      walk(t, 1);
      const started = await untilRoutineEvent(t, id, (event) => event.type === "routine.firing-started" && event.payload["dueAt"] === at);
      expect(started).toMatchObject({ occurredAt: at, payload: { trigger: "schedule", count: 1, requestedBy: null } });
      await untilSettled(t, id, started.payload["firingId"] as string);
    }
    for (const [index, { due }] of kinds.entries()) expect(records(t, ids[index] ?? "").map((record) => [record.type, record["dueAt"]])).toEqual(due.map((at) => ["routine.firing-started", at]));
  });

  it("skips a due time `overlap` while a firing of its routine is starting or live, and fires the next once it has ended", async () => {
    const root = tempDir();
    const resolving = heldGate();
    const resolver = scriptedResolver(async ({ sessionId }) => {
      if (resolver.calls.length === 1) await resolving.opened;
      return makeDirectory(join(root, sessionId), { kind: "scratch", path: join(root, sessionId) });
    });
    const runs = heldRuns();
    const t = await start({ workspaceResolver: resolver, adapter: fakeAdapter({ script: runs.script }) });
    const client = await t.client();
    const { state } = await created(client, routine({ name: "Every five minutes", schedule: { kind: "cron", expression: "*/5 * * * *" } }));
    await client.close();

    // 00:05 starts, its workspace held; 00:10 comes while it is starting.
    walk(t, 10);
    const overlapped = await untilDue(t, state.id, "2026-09-24T00:10:00.000Z");
    expect(overlapped).toMatchObject({ type: "routine.skipped", actor: `routine:${state.id}`, payload: { trigger: "schedule", reason: "overlap", count: 1, preCheck: null } });
    resolving.open();
    const first = await untilDue(t, state.id, "2026-09-24T00:05:00.000Z");
    expect(first).toMatchObject({ type: "routine.firing-started", payload: { trigger: "schedule" } });

    // 00:15 comes while its run is live; 00:20 after it has ended.
    walk(t, 5);
    await untilDue(t, state.id, "2026-09-24T00:15:00.000Z");
    runs.end(first.payload["sessionId"] as string);
    await untilSettled(t, state.id, first.payload["firingId"] as string);
    walk(t, 5);
    await untilDue(t, state.id, "2026-09-24T00:20:00.000Z");

    expect(summary(t, state.id)).toEqual([
      ["skip", "2026-09-24T00:10:00.000Z", "overlap", 1],
      ["firing", "2026-09-24T00:05:00.000Z", "schedule", 1],
      ["skip", "2026-09-24T00:15:00.000Z", "overlap", 1],
      ["firing", "2026-09-24T00:20:00.000Z", "schedule", 1],
    ]);
    const reader = await t.client();
    expect((await history(reader, state.id)).map((entry) => [entry.kind, entry.dueAt])).toEqual([
      ["firing", "2026-09-24T00:20:00.000Z"],
      ["skip", "2026-09-24T00:15:00.000Z"],
      ["firing", "2026-09-24T00:05:00.000Z"],
      ["skip", "2026-09-24T00:10:00.000Z"],
    ]);
    expect((await listed(reader, state.id))?.state.handledThrough).toBe("2026-09-24T00:20:00.000Z");
  });

  it("has at most four firings in a pre-check or a run, whatever started them; the rest wait in order and start as slots free, unless disabled meanwhile", async () => {
    const runs = heldRuns();
    const t = await start({ adapter: fakeAdapter({ script: runs.script }) });
    const client = await t.client();
    const byHand = await created(client, routine({ name: "By hand", schedule: { kind: "manual" } }));
    const ids: string[] = [];
    for (const name of ["First", "Second", "Third", "Fourth", "Fifth"]) ids.push((await created(client, routine({ name, schedule: { kind: "daily", at: "09:00" } }))).state.id);
    const [first, second, third, fourth, fifth] = ids as [string, string, string, string, string];
    const byHandFiring = await untilStarted(t, byHand.state.id, await ranNow(client, byHand.state.id));
    await client.close();

    // At 09:00 the run now holds one slot: three of the five start, and the fourth and the fifth wait, the fifth disabled meanwhile.
    walk(t, 60);
    const started = await Promise.all([first, second, third].map((id) => untilDue(t, id, "2026-09-24T01:00:00.000Z")));
    walk(t, 3);
    expect(records(t, fourth)).toEqual([]);
    const watcher = await t.client();
    expect((await listed(watcher, fourth))?.state.liveFiring).toBeNull();
    expect((await runNow(watcher, fourth)).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "firing_running" } } });
    await routineCommand(watcher, "routines.disable", { routineId: fifth });

    // The run now ends at 09:03: the fourth starts then, for its 09:00 due time.
    runs.end(byHandFiring.payload["sessionId"] as string);
    const late = await untilDue(t, fourth, "2026-09-24T01:00:00.000Z");
    expect(late).toMatchObject({ type: "routine.firing-started", occurredAt: "2026-09-24T01:03:00.000Z", payload: { trigger: "schedule", count: 1 } });

    // A run now waits for a slot as well, behind the disabled fifth, which is dropped when its turn comes.
    const again = await ranNow(watcher, byHand.state.id);
    expect(records(t, byHand.state.id)).toHaveLength(1);
    runs.end(started[0]?.payload["sessionId"] as string);
    expect(await untilStarted(t, byHand.state.id, again)).toMatchObject({ payload: { trigger: "run-now" } });
    expect([second, third, fourth, fifth].map((id) => records(t, id).length)).toEqual([1, 1, 1, 0]);
  });

  it("puts the due times missed while the environment was stopped through the missed rule once: collapsed, caught up within seven days or skipped", async () => {
    const t = await start({ dataDir: join(tempDir(), "data") });
    const client = await t.client();
    const make = async (name: string, overrides: Partial<RoutineDefinitionInput>) => (await created(client, routine({ name, ...overrides }))).state.id;
    const daily = await make("Daily", { schedule: { kind: "daily", at: "09:00" } });
    const skipper = await make("Skipper", { schedule: { kind: "daily", at: "09:00" }, ifMissed: "skip" });
    const monthly = await make("Monthly", { schedule: { kind: "monthly", day: 24, at: "09:00" } });
    const disabled = await make("Disabled", { schedule: { kind: "daily", at: "09:00" }, enabled: false });
    const byHand = await make("By hand", { schedule: { kind: "manual" } });

    // Stopped from Thursday 08:00 to Saturday 2026-10-03 08:00 in Manila: nine daily due times, the last at 09:00 yesterday.
    const back = await restartAfter(t, 9 * DAY, (options) => start(options));
    const caughtUp = await untilRecorded(back, daily);
    expect(caughtUp).toMatchObject({
      type: "routine.firing-started",
      occurredAt: "2026-10-03T00:00:00.000Z",
      payload: { trigger: "catch-up", dueAt: "2026-10-02T01:00:00.000Z", count: 9, requestedBy: null },
    });
    await untilSettled(back, daily, caughtUp.payload["firingId"] as string);
    expect(summary(back, skipper)).toEqual([["skip", "2026-10-02T01:00:00.000Z", "missed", 9]]);
    // Its one due time is more than seven days old.
    expect(summary(back, monthly)).toEqual([["skip", "2026-09-24T01:00:00.000Z", "missed", 1]]);
    expect(records(back, disabled)).toEqual([]);
    expect(records(back, byHand)).toEqual([]);
    const reader = await back.client();
    expect(Object.fromEntries((await Promise.all([daily, skipper, monthly].map((id) => listed(reader, id)))).map((made) => [made?.definition.name, [made?.state.handledThrough, made?.nextDueAt]]))).toEqual({
      Daily: ["2026-10-02T01:00:00.000Z", "2026-10-03T01:00:00.000Z"],
      Skipper: ["2026-10-02T01:00:00.000Z", "2026-10-03T01:00:00.000Z"],
      Monthly: ["2026-09-24T01:00:00.000Z", "2026-10-24T01:00:00.000Z"],
    });

    // Started again at once, nothing more is owed: a run now is taken, as none is starting, and it is the one record more.
    const again = await restartAfter(back, 0, (options) => start(options));
    const byClient = await ranNow(await again.client(), daily);
    await untilSettled(again, daily, byClient);
    expect(summary(again, daily)).toEqual([
      ["firing", "2026-10-02T01:00:00.000Z", "catch-up", 9],
      ["firing", "2026-10-03T00:00:00.000Z", "run-now", 1],
    ]);
    expect([skipper, monthly].map((id) => records(again, id).length)).toEqual([1, 1]);
  });

  it("finds the due times a sleep passed by the wall clock within a minute of waking, the latest of those over two minutes late caught up", async () => {
    const t = await start();
    const client = await t.client();
    const often = (await created(client, routine({ name: "Every five minutes", schedule: { kind: "cron", expression: "*/5 * * * *" } }))).state.id;
    const daily = (await created(client, routine({ name: "Daily", schedule: { kind: "daily", at: "09:00" } }))).state.id;
    await client.close();

    // The machine sleeps three hours from 08:00 in Manila: its timers stand still, its wall clock moves on.
    t.clock.jump(3 * 60 * MINUTE);
    expect(records(t, often)).toEqual([]);
    walk(t, 1);
    const caughtUp = await untilDue(t, often, "2026-09-24T02:55:00.000Z");
    expect(caughtUp).toMatchObject({ type: "routine.firing-started", occurredAt: "2026-09-24T03:01:00.000Z", payload: { trigger: "catch-up", count: 35 } });
    // 03:00 is a minute late, on time, and comes while the catch-up is starting.
    expect(summary(t, often)).toEqual([
      ["skip", "2026-09-24T03:00:00.000Z", "overlap", 1],
      ["firing", "2026-09-24T02:55:00.000Z", "catch-up", 35],
    ]);
    const missed = await untilDue(t, daily, "2026-09-24T01:00:00.000Z");
    expect(missed).toMatchObject({ type: "routine.firing-started", payload: { trigger: "catch-up", count: 1 } });
  });

  it("fires on time after a clock jumped forward past a due time, found by the check rather than the timer", async () => {
    const t = await start();
    const client = await t.client();
    const daily = (await created(client, routine({ name: "Daily", schedule: { kind: "daily", at: "09:00" } }))).state.id;
    await client.close();

    // At 08:30 in Manila the clock is set forward half an hour: the timer still waits thirty minutes for 09:00.
    walk(t, 30);
    t.clock.jump(30 * MINUTE);
    walk(t, 1);
    const fired = await untilDue(t, daily, "2026-09-24T01:00:00.000Z");
    expect(fired).toMatchObject({ type: "routine.firing-started", occurredAt: "2026-09-24T01:01:00.000Z", payload: { trigger: "schedule", count: 1 } });
    await untilSettled(t, daily, fired.payload["firingId"] as string);
    walk(t, 30);
    expect(records(t, daily)).toHaveLength(1);
  });

  it("never fires a disabled or a manual routine from the schedule, and owes a routine enabled again nothing from before its enabling", async () => {
    const t = await start();
    let client = await t.client();
    const byHand = (await created(client, routine({ name: "By hand", schedule: { kind: "manual" } }))).state.id;
    const daily = (await created(client, routine({ name: "Daily", schedule: { kind: "daily", at: "09:00" } }))).state.id;
    expect((await routineCommand(client, "routines.disable", { routineId: daily })).result?.routine).toMatchObject({ state: { handledThrough: MANUAL_CLOCK_START }, nextDueAt: null });
    expect((await listed(client, byHand))?.nextDueAt).toBeNull();
    await client.close();

    walk(t, 90);
    expect(records(t, daily)).toEqual([]);
    expect(records(t, byHand)).toEqual([]);

    // Enabled at 09:30 in Manila: 09:00 today is not owed, and an enable of an enabled routine moves nothing.
    client = await t.client();
    const enabled = (await routineCommand(client, "routines.enable", { routineId: daily })).result?.routine;
    expect(enabled).toMatchObject({ state: { handledThrough: "2026-09-24T01:30:00.000Z" }, nextDueAt: "2026-09-25T01:00:00.000Z" });
    await client.close();
    walk(t, 5);
    client = await t.client();
    expect((await routineCommand(client, "routines.enable", { routineId: daily })).result?.routine.state.handledThrough).toBe("2026-09-24T01:30:00.000Z");
    await client.close();
    walk(t, 60);
    expect(records(t, daily)).toEqual([]);
  });

  it("moves handledThrough to the save time when an edit changes the schedule or the zone, so no earlier due time is owed", async () => {
    const t = await start();
    let client = await t.client();
    const hourly = (await created(client, routine({ name: "Hourly", schedule: { kind: "hourly", minute: 30 } }))).state.id;
    await client.close();
    walk(t, 10);

    // At 08:10 in Manila, 08:05 would be owed under the new schedule had the edit not moved handledThrough.
    client = await t.client();
    const update = async (fields: Record<string, unknown>) => (await routineCommand(client, "routines.update", { routineId: hourly, fields })).result?.routine;
    expect(await update({ schedule: { kind: "hourly", minute: 5 } })).toMatchObject({ state: { handledThrough: "2026-09-24T00:10:00.000Z" }, nextDueAt: "2026-09-24T01:05:00.000Z" });
    await client.close();
    walk(t, 5);
    client = await t.client();
    // Editing the instructions, or saving the schedule it has, moves nothing; a new zone does.
    expect((await update({ instructions: "Read the sources again.", schedule: { kind: "hourly", minute: 5 } }))?.state.handledThrough).toBe("2026-09-24T00:10:00.000Z");
    expect(await update({ timezone: "Asia/Tokyo" })).toMatchObject({ state: { handledThrough: "2026-09-24T00:15:00.000Z" }, nextDueAt: "2026-09-24T01:05:00.000Z" });
    await client.close();
    walk(t, 45);
    expect(records(t, hourly)).toEqual([]);
    walk(t, 5);
    expect(await untilDue(t, hourly, "2026-09-24T01:05:00.000Z")).toMatchObject({ type: "routine.firing-started", payload: { trigger: "schedule", count: 1 } });
  });

  it("runs a routine's pre-check before each scheduled firing: changed output fires, unchanged output is a skip `no-change`", async () => {
    const t = await start();
    const script = join(t.dataDir, "scripts", "watch.sh");
    writeFileSync(script, "#!/bin/sh\nprintf 'v1.2.0\\n'\n");
    chmodSync(script, 0o755);
    const client = await t.client();
    const watch = (await created(client, routine({ name: "Watch", schedule: { kind: "hourly", minute: 30 }, preCheck: { kind: "script", path: "watch.sh" } }))).state.id;
    await client.close();

    walk(t, 30);
    const fired = await untilDue(t, watch, "2026-09-24T00:30:00.000Z");
    expect(fired).toMatchObject({ type: "routine.firing-started", payload: { trigger: "schedule", preCheck: { output: "v1.2.0\n", differs: null } } });
    await untilSettled(t, watch, fired.payload["firingId"] as string);
    walk(t, 60);
    expect(await untilDue(t, watch, "2026-09-24T01:30:00.000Z")).toMatchObject({ type: "routine.skipped", payload: { trigger: "schedule", reason: "no-change", count: 1 } });
    const reader = await t.client();
    expect((await listed(reader, watch))?.state).toMatchObject({ handledThrough: "2026-09-24T01:30:00.000Z", lastOutcome: { kind: "skip", reason: "no-change" } });
  });
});
