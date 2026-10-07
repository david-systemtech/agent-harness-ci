import { randomUUID } from "node:crypto";
import { DEFAULT_THEME, EnvironmentNotice, STEP_REGISTRY, registry, type EventFrame, type Frame, type ResultOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { answeringCheck, appendedAfter, lateCheck, scriptedStep } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import type { SetupSteps } from "./service.js";

/**
 * The checks the environment starts itself (the Set up specification,
 * "Running checks"; ADR 0031; #571) through the primary seam: an in-process
 * environment on the manual clock, restarted on one data directory, with a
 * registry of scripted steps whose state checks hold, fail or hang as the
 * test says, and count their calls. What is asserted is what a client sees
 * once it connects (the snapshot's results, the `setup.result-changed`
 * notices, what `setup.check` answers) and how often each scripted check was
 * asked; the clock moves while no client is connected, so every check here
 * runs with nobody looking.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/**
 * Lets the checks the clock just started finish: a scripted check that
 * answers at once is kept within the promises its start settles, which one
 * turn of the event loop runs, whatever the wall clock.
 */
const checksSettled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Moves the clock on by `ms`, then lets the checks it started finish. */
const advance = async (t: TestEnvironment, ms: number): Promise<void> => {
  t.clock.advance(ms);
  await checksSettled();
};

/** The next frame of `type` for `subscription`. */
const frame = <T extends Frame["type"]>(client: WireClient, subscription: string, type: T) =>
  client.next((f): f is Extract<Frame, { type: T }> => f.type === type && "subscription" in f && f.subscription === subscription);

/** `environment.subscribe`'s snapshot, as a subscriber is sent it whose cursor is past the head. */
const snapshot = async (t: TestEnvironment, client: WireClient): Promise<ResultOf<"environment.subscribe">> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
  return registry["environment.subscribe"].result.parse((await frame(client, subscription, "snapshot")).payload);
};

/** Whether `f` is an event on `subscription`. */
const isEvent =
  (subscription: string) =>
  (f: Frame): f is EventFrame =>
    f.type === "event" && f.subscription === subscription;

/** Subscribes `client` to the environment stream from its start, and answers every notice on it once it is synchronized. */
const environmentStream = async (client: WireClient): Promise<EnvironmentNotice[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
  await frame(client, subscription, "synchronized");
  return client.received.filter(isEvent(subscription)).map((f) => EnvironmentNotice.parse(f.event));
};

/** The results of the `setup.result-changed` notices among `notices`, in order. */
const resultsOf = (notices: readonly EnvironmentNotice[]): StepResult[] => notices.flatMap((notice) => (notice.type === "setup.result-changed" ? [notice.payload] : []));

describe("the start pass", () => {
  it("checks every registered step once the start is done, with no client connected, so the snapshot holds each step's result without any client having asked", async () => {
    const holds = answeringCheck();
    const fails = answeringCheck();
    fails.answer({ reason: "The denylist's paths section is missing ~/.aws." });
    const hangs = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("account", { stateChecks: [{ id: "account.holds", holds: "It holds.", actions: [] }] }),
          scriptedStep("permissions", { stateChecks: [{ id: "permissions.fails", holds: "It would hold.", actions: ["restore"] }] }),
          scriptedStep("appearance", { stateChecks: [{ id: "appearance.hangs", holds: "It would answer.", actions: [] }] }),
        ],
        stateChecks: { "account.holds": holds.checker, "permissions.fails": fails.checker, "appearance.hangs": hangs.checker },
      },
    });

    // Nobody has connected. The step that hangs is asked, and answers only once its budget has run out on the clock.
    await hangs.call(1);
    t.clock.advance(5_000);
    await t.env.setup.startPass;
    expect([holds.calls(), fails.calls(), hangs.calls()]).toEqual([1, 1, 1]);

    const client = await t.client();
    const expected = [
      { step: "account", state: "done", reason: "Set up here.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START },
      {
        step: "permissions",
        state: "needs-attention",
        reason: "The denylist's paths section is missing ~/.aws.",
        failing: ["permissions.fails"],
        actions: ["restore"],
        checkedAt: MANUAL_CLOCK_START,
      },
      {
        step: "appearance",
        state: "needs-attention",
        reason: "could not check: timed out after 5 s",
        failing: ["appearance.hangs"],
        actions: ["check-again"],
        checkedAt: MANUAL_CLOCK_START,
      },
    ];
    expect((await snapshot(t, client)).setup).toEqual(expected);
    // Each first result is noticed, after the start was.
    const notices = await environmentStream(client);
    expect(notices.map((notice) => notice.type)).toEqual(["environment.started", "setup.result-changed", "setup.result-changed", "setup.result-changed"]);
    expect(resultsOf(notices)).toEqual(expect.arrayContaining(expected));
  });
});

/** Account, checked hourly, and Forges, every fifteen minutes with its reason: each with one scripted state check that holds. */
const cadenceRegistry = () => {
  const hourly = answeringCheck();
  const quarterly = answeringCheck();
  const setupSteps: SetupSteps = {
    steps: [
      scriptedStep("account", { stateChecks: [{ id: "account.hourly", holds: "Checked hourly.", actions: [] }] }),
      scriptedStep("forges", {
        cadence: { minutes: 15, reason: "Checked as often as a forge account is verified." },
        stateChecks: [{ id: "forges.quarterly", holds: "Checked every fifteen minutes.", actions: [] }],
      }),
    ],
    stateChecks: { "account.hourly": hourly.checker, "forges.quarterly": quarterly.checker },
  };
  /** How often each was asked: Account's, then Forges'. */
  const calls = (): number[] => [hourly.calls(), quarterly.calls()];
  return { setupSteps, calls };
};

/** Each step's cached result's checked-at, as the snapshot carries them to a client connected now. */
const checkedAts = async (t: TestEnvironment): Promise<string[][]> => {
  const client = await t.client();
  const { setup } = await snapshot(t, client);
  await client.close();
  return (setup ?? []).map((result) => [result.step, result.checkedAt]);
};

describe("the cadence", () => {
  it("checks a step again once its cadence has passed since its cached result, sixty minutes or the entry's own fifteen, with no client connected", async () => {
    const { setupSteps, calls } = cadenceRegistry();
    const t = await start({ setupSteps });
    await t.env.setup.startPass;
    expect(calls()).toEqual([1, 1]);

    await advance(t, 15 * MINUTE - 1);
    expect(calls()).toEqual([1, 1]);
    await advance(t, 1);
    expect(calls()).toEqual([1, 2]);
    await advance(t, 15 * MINUTE);
    await advance(t, 15 * MINUTE);
    await advance(t, 15 * MINUTE - 1);
    expect(calls()).toEqual([1, 4]);
    await advance(t, 1);
    expect(calls()).toEqual([2, 5]);
    expect(await checkedAts(t)).toEqual([
      ["account", after(HOUR)],
      ["forges", after(HOUR)],
    ]);
  });

  it("counts from the cached result whatever checked it last: a step a client asked for since is checked its cadence after that", async () => {
    const { setupSteps, calls } = cadenceRegistry();
    const t = await start({ setupSteps });
    await t.env.setup.startPass;
    await advance(t, 10 * MINUTE);
    const client = await t.client();
    await client.request("setup.check", { step: "forges" });
    await client.close();
    expect(calls()).toEqual([1, 2]);

    await advance(t, 5 * MINUTE);
    await advance(t, 10 * MINUTE - 1);
    expect(calls()).toEqual([1, 2]);
    await advance(t, 1);
    expect(calls()).toEqual([1, 3]);
    expect(await checkedAts(t)).toEqual([
      ["account", MANUAL_CLOCK_START],
      ["forges", after(25 * MINUTE)],
    ]);
  });

  it("counts, after a restart on the same data directory, from the checked-at the cache holds, which that start's pass moved on", async () => {
    const { setupSteps, calls } = cadenceRegistry();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    await first.env.setup.startPass;
    await advance(first, 15 * MINUTE);
    await advance(first, 15 * MINUTE);
    expect(calls()).toEqual([1, 3]);
    await first.close();

    // Started again fifty minutes after the first start, whose Account result is from its start and its Forges result from thirty minutes on.
    const second = await start({ dataDir, setupSteps, clock: manualClock(after(50 * MINUTE)) });
    await second.env.setup.startPass;
    expect(calls()).toEqual([2, 4]);
    expect(await checkedAts(second)).toEqual([
      ["account", after(50 * MINUTE)],
      ["forges", after(50 * MINUTE)],
    ]);
    // Not an hour after the first start's Account result, nor fifteen minutes after its last Forges result.
    await advance(second, 15 * MINUTE - 1);
    expect(calls()).toEqual([2, 4]);
    await advance(second, 1);
    expect(calls()).toEqual([2, 5]);
    await advance(second, 15 * MINUTE);
    await advance(second, 15 * MINUTE);
    await advance(second, 15 * MINUTE - 1);
    expect(calls()).toEqual([2, 7]);
    await advance(second, 1);
    expect(calls()).toEqual([3, 8]);
    expect(await checkedAts(second)).toEqual([
      ["account", after(110 * MINUTE)],
      ["forges", after(110 * MINUTE)],
    ]);
  });

  it("counts a cached result dated later than now, as after the clock was set back, as due: the step waits no longer than its cadence", async () => {
    const { setupSteps, calls } = cadenceRegistry();
    const t = await start({ setupSteps });
    await t.env.setup.startPass;
    const client = await t.client();
    const [account] = (await snapshot(t, client)).setup ?? [];
    await client.close();
    // The lower seam: Account's row as a check three hours on would have left it, under a clock since set back.
    t.env.log.atomically((tx) => t.env.log.setupResults.write(tx, "account", JSON.stringify({ ...account, checkedAt: after(3 * HOUR) })));

    for (let quarter = 0; quarter < 3; quarter += 1) await advance(t, 15 * MINUTE);
    await advance(t, 15 * MINUTE - 1);
    expect(calls()[0]).toBe(1);
    await advance(t, 1);
    expect(calls()[0]).toBe(2);
  });
});

describe("what a pass the environment starts appends", () => {
  it("is nothing when an hourly pass changes nothing, the cache taking its checked-at, and setup.result-changed when it changes a result", async () => {
    const holds = answeringCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { stateChecks: [{ id: "account.signed-in", holds: "Every account is signed in.", actions: ["sign-in-again"] }] })],
        stateChecks: { "account.signed-in": holds.checker },
      },
    });
    await t.env.setup.startPass;
    const head = t.env.log.head();

    await advance(t, HOUR);
    expect(holds.calls()).toBe(2);
    expect(appendedAfter(t.env.log, head)).toEqual([]);
    expect(await checkedAts(t)).toEqual([["account", after(HOUR)]]);

    holds.answer({ reason: "Work is signed out." });
    await advance(t, HOUR);
    expect(holds.calls()).toBe(3);
    const client = await t.client();
    expect(resultsOf(await environmentStream(client))).toEqual([
      { step: "account", state: "done", reason: "Set up here.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START },
      { step: "account", state: "needs-attention", reason: "Work is signed out.", failing: ["account.signed-in"], actions: ["sign-in-again"], checkedAt: after(2 * HOUR) },
    ]);
  });
});

/** Appends an event of `type` on a stream of the test's own, as any feature appends one on its own. */
const poke = (t: TestEnvironment, type: string): void => {
  t.env.log.append({ kind: "test", id: "pokes" }, [{ type, payload: {} }], { actor: "system:test" });
};

/** An environment whose one step, Account, names `triggers` and holds, past its start pass. */
const triggeredStep = async (triggers: readonly string[]): Promise<{ t: TestEnvironment; calls: () => number }> => {
  const holds = answeringCheck();
  const t = await start({
    setupSteps: {
      steps: [scriptedStep("account", { triggers, stateChecks: [{ id: "account.holds", holds: "It holds.", actions: [] }] })],
      stateChecks: { "account.holds": holds.checker },
    },
  });
  await t.env.setup.startPass;
  return { t, calls: holds.calls };
};

describe("the triggers", () => {
  it("check a step within a second of an event it names arriving on any stream, and once for a burst inside that second", async () => {
    const { t, calls } = await triggeredStep(["test.poked"]);
    expect(calls()).toBe(1);
    poke(t, "test.poked");
    await advance(t, 999);
    expect(calls()).toBe(1);
    await advance(t, 1);
    expect(calls()).toBe(2);

    poke(t, "test.poked");
    await advance(t, 400);
    poke(t, "test.poked");
    await advance(t, 400);
    poke(t, "test.poked");
    await advance(t, 199);
    expect(calls()).toBe(2);
    await advance(t, 1);
    expect(calls()).toBe(3);
    await advance(t, 10_000);
    expect(calls()).toBe(3);

    // An event of a type it does not name checks nothing.
    poke(t, "test.prodded");
    await advance(t, 1_000);
    expect(calls()).toBe(3);
  });

  it("match every type a family trigger prefixes, and no other", async () => {
    const { t, calls } = await triggeredStep(["test.family.*"]);
    poke(t, "test.family.one");
    await advance(t, 1_000);
    expect(calls()).toBe(2);
    poke(t, "test.family.two");
    await advance(t, 1_000);
    expect(calls()).toBe(3);
    poke(t, "test.familiar");
    poke(t, "test.family");
    await advance(t, 1_000);
    expect(calls()).toBe(3);
  });

  it("check a step on settings.updated only when the keys it names include one the step writes", async () => {
    const machines = answeringCheck();
    const appearance = answeringCheck();
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("your-machines", {
            writes: ["sessions.autoSettleOnMerge"],
            triggers: ["settings.updated"],
            stateChecks: [{ id: "your-machines.holds", holds: "It holds.", actions: [] }],
          }),
          scriptedStep("appearance", { writes: ["appearance.theme"], triggers: ["settings.updated"], stateChecks: [{ id: "appearance.holds", holds: "It holds.", actions: [] }] }),
        ],
        stateChecks: { "your-machines.holds": machines.checker, "appearance.holds": appearance.checker },
      },
    });
    await t.env.setup.startPass;
    const client = await t.client();
    const calls = () => [machines.calls(), appearance.calls()];

    await client.request("settings.update", { commandId: randomUUID(), values: { "appearance.theme": { ...DEFAULT_THEME, name: "Renamed" } } });
    await advance(t, 1_000);
    expect(calls()).toEqual([1, 2]);

    await client.request("settings.update", { commandId: randomUUID(), values: { "sessions.autoSettleOnMerge": true } });
    await advance(t, 1_000);
    expect(calls()).toEqual([2, 2]);
  });
});

describe("one check of a step at a time", () => {
  it("gives a setup.check and the cadence that arrive while the step's check runs that run's result, running nothing beside it", async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { budget: "git", stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: [] }] })],
        stateChecks: { "account.late": late.checker },
      },
    });
    (await late.call(1)).answer(true);
    await t.env.setup.startPass;
    await advance(t, HOUR - 10_000);

    const client = await t.client();
    const asked = client.request("setup.check", { step: "account" });
    const call = await late.call(2);
    // While it runs: its cadence falls due, and it is asked for again, which the environment has taken once a request sent
    // after it is answered.
    t.clock.advance(10_000);
    const again = client.request("setup.check", { step: "account" });
    await client.request("settings.get", { keys: ["appearance.theme"] });
    call.answer({ reason: "The late check found a problem." });

    const result = { step: "account", state: "needs-attention", reason: "The late check found a problem.", failing: ["account.late"], actions: [], checkedAt: after(HOUR - 10_000) };
    expect((await asked).results).toEqual([result]);
    expect((await again).results).toEqual([result]);
    await advance(t, 1_000);
    expect(late.calls()).toBe(2);
  });
});

describe("a trigger that arrives while the step's check runs", () => {
  /**
   * Your machines, writing `sessions.autoSettleOnMerge`, which it holds only
   * when on: its check reads the setting as it starts, then waits on a state
   * check the test answers by hand. Past its start pass, the setting off.
   */
  const heldMachines = async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("your-machines", {
            writes: ["sessions.autoSettleOnMerge"],
            checks: [{ key: "sessions.autoSettleOnMerge", check: (value) => value === true || "Sessions are not settled on merge." }],
            budget: "network",
            triggers: ["settings.updated"],
            stateChecks: [{ id: "your-machines.late", holds: "The late check holds.", actions: [] }],
          }),
        ],
        stateChecks: { "your-machines.late": late.checker },
      },
    });
    (await late.call(1)).answer(true);
    await t.env.setup.startPass;
    return { t, late };
  };

  it("has the step checked once more a second after that run ends, so a change that landed mid-run is read as it is now, not as the run read it", async () => {
    const { t, late } = await heldMachines();
    const client = await t.client();
    const asked = client.request("setup.check", { step: "your-machines" });
    const held = await late.call(2);
    // The run read the setting off as it started; it is turned on while the run waits, which triggers the step.
    await client.request("settings.update", { commandId: randomUUID(), values: { "sessions.autoSettleOnMerge": true } });
    await advance(t, 5_000);
    expect(late.calls()).toBe(2);
    held.answer(true);
    expect((await asked).results).toEqual([
      { step: "your-machines", state: "needs-attention", reason: "Sessions are not settled on merge.", failing: ["sessions.autoSettleOnMerge"], actions: [], checkedAt: after(0) },
    ]);

    // A second after the run ended, not after the trigger arrived.
    await advance(t, 999);
    expect(late.calls()).toBe(2);
    await advance(t, 1);
    expect(late.calls()).toBe(3);
    (await late.call(3)).answer(true);
    await checksSettled();
    const done = { step: "your-machines", state: "done", reason: "Set up here.", failing: [], actions: [], checkedAt: after(6_000) };
    expect((await snapshot(t, client)).setup).toEqual([done]);
    expect(resultsOf(await environmentStream(client)).at(-1)).toEqual(done);
  });

  it("is any trigger, what the run's own verification records included: the step is checked once more, and not again once a check records nothing", async () => {
    let calls = 0;
    /** What the next verification records as it runs, once: a forge account it found changed. */
    let records: (() => void) | undefined;
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("forges", { triggers: ["test.verified"], stateChecks: [{ id: "forges.verified", holds: "Every forge account is verified.", actions: [] }] })],
        stateChecks: {
          "forges.verified": () => {
            calls += 1;
            records?.();
            records = undefined;
            return true;
          },
        },
      },
    });
    await t.env.setup.startPass;
    records = () => poke(t, "test.verified");
    await (await t.client()).request("setup.check", { step: "forges" });
    expect(calls).toBe(2);
    await advance(t, 1_000);
    expect(calls).toBe(3);
    await advance(t, 10_000);
    expect(calls).toBe(3);
  });
});

describe("the last good result", () => {
  const late = () => {
    const check = lateCheck();
    const setupSteps: SetupSteps = {
      steps: [scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: [] }] })],
      stateChecks: { "account.late": check.checker },
    };
    return { check, setupSteps };
  };

  it("comes from the cache across a restart: a result that timed out, or could not check, carries the cached done result's line and checked-at", async () => {
    const { check, setupSteps } = late();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    (await check.call(1)).answer(true);
    await first.env.setup.startPass;
    await first.close();

    const lastGood = { state: "done", reason: "Set up here.", checkedAt: MANUAL_CLOCK_START };
    const second = await start({ dataDir, setupSteps, clock: manualClock(after(2 * HOUR)) });
    await check.call(2);
    second.clock.advance(5_000);
    await second.env.setup.startPass;
    const client = await second.client();
    expect((await snapshot(second, client)).setup).toEqual([
      { step: "account", state: "needs-attention", reason: "could not check: timed out after 5 s", failing: ["account.late"], actions: ["check-again"], checkedAt: after(2 * HOUR), lastGood },
    ]);
    await second.close();

    // Started once more, its check throws: the cached result that timed out passes the same last good result on.
    const third = await start({ dataDir, setupSteps, clock: manualClock(after(4 * HOUR)) });
    (await check.call(3)).fail(new Error("the account store is locked"));
    await third.env.setup.startPass;
    expect((await snapshot(third, await third.client())).setup).toEqual([
      { step: "account", state: "needs-attention", reason: "Could not check account.late: the account store is locked.", failing: ["account.late"], actions: [], checkedAt: after(4 * HOUR), lastGood },
    ]);
  });

  it("is absent when the cached result needs attention and carries none, as a check that failed does", async () => {
    const { check, setupSteps } = late();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    (await check.call(1)).answer(true);
    await first.env.setup.startPass;
    const client = await first.client();
    const asked = client.request("setup.check", { step: "account" });
    (await check.call(2)).answer({ reason: "The late check found a problem." });
    expect((await asked).results[0]).not.toHaveProperty("lastGood");
    await first.close();

    const second = await start({ dataDir, setupSteps, clock: manualClock(after(HOUR)) });
    await check.call(3);
    second.clock.advance(5_000);
    await second.env.setup.startPass;
    const [result] = (await snapshot(second, await second.client())).setup ?? [];
    expect(result).toMatchObject({ state: "needs-attention", reason: "could not check: timed out after 5 s" });
    expect(result).not.toHaveProperty("lastGood");
  });
});

describe("who the checks run as", () => {
  it("appends the results the environment's checks change as system:setup, and a verification a check runs records what it finds as that verification does, whoever asked", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    const t = await start({ forgeFetch: forge.fetch });
    await t.env.setup.startPass;
    const admin = await t.client();
    await added(admin, { url: forge.origin, kind: "forgejo" });

    // A program that may only read asks for the Forges step, whose check verifies the forge account it finds.
    const program = await t.client({ token: (await t.pair({ scopes: ["read"], kind: "program" })).token });
    const { results } = await program.request("setup.check", { step: "forges" });
    expect(results.map((result) => [result.step, result.state])).toEqual([["forges", "done"]]);

    const { subscription } = await program.subscribe("environment.subscribe", { afterSequence: 0 });
    await frame(program, subscription, "synchronized");
    const events = program.received.filter(isEvent(subscription)).map((f) => [f.event.type, f.event.actor]);
    const setupActors = events.filter(([type]) => type === "setup.result-changed").map(([, actor]) => actor);
    // The start pass's first result of every registered step, and Forges done once it had a forge account.
    expect(setupActors).toEqual(Array.from({ length: STEP_REGISTRY.length + 1 }, () => ({ kind: "system", id: "setup" })));
    expect(events.filter(([type]) => type === "forge.account.verified")).toEqual([["forge.account.verified", { kind: "system", id: "forge" }]]);
  });
});
