import { DISCOVERY_PATH, DiscoveryDocument, EnvironmentNotice, registry, type EventFrame, type Frame, type RegisteredStepId, type ResultOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { appendedAfter, lateCheck, scriptedStep } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import { PRESET_IDLE_WINDOW_MS } from "../serve/run-registry.js";
import type { SetupSteps } from "./service.js";

/**
 * The result cache and ADR 0031's `setup` subscription through the primary
 * seam (the Set up specification, "Results, the cache and the
 * subscription"; #569): an in-process environment, restarted on one data
 * directory, driven by real clients over real WebSockets, with a registry
 * of scripted steps whose checks hold, fail or throw as the test says, each
 * test past the start pass that checks them all as the environment starts
 * (#571). What is asserted is what a client sees: what `setup.check`
 * answers, the `setup.result-changed` notices on the environment stream,
 * and `environment.subscribe`'s snapshot; never the cache's table.
 */

const { onCleanup, tempDir } = useCleanups();

/** An environment past its start pass (#571), whose scripted checks here answer at once. */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** What each scripted state check answers when it runs: it holds, the line saying what does not, or an error it throws. */
type Answer = StateCheckAnswer | Error;

/**
 * A registry of three scripted steps: Account and Permissions, each with one
 * state check answering what the test last set, and Appearance with none
 * between them in the registry's order.
 */
const scriptedRegistry = () => {
  const answers: { account: Answer; permissions: Answer } = { account: true, permissions: true };
  const answer = (value: Answer): StateCheckAnswer => {
    if (value instanceof Error) throw value;
    return value;
  };
  const setupSteps: SetupSteps = {
    steps: [
      scriptedStep("account", { stateChecks: [{ id: "account.signed-in", holds: "All your accounts are signed in.", actions: ["sign-in-again"] }] }),
      scriptedStep("permissions", { stateChecks: [{ id: "permissions.denylist", holds: "The denylist holds its presets.", actions: ["restore"] }] }),
      scriptedStep("appearance"),
    ],
    stateChecks: { "account.signed-in": () => answer(answers.account), "permissions.denylist": () => answer(answers.permissions) },
  };
  return { answers, setupSteps };
};

/** The one result `setup.check` answers for `step`. */
const check = async (client: WireClient, step: RegisteredStepId): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step });
  expect(results.map((result) => result.step)).toEqual([step]);
  return results[0] as StepResult;
};

/** The next frame of `type` for `subscription`. */
const frame = <T extends Frame["type"]>(client: WireClient, subscription: string, type: T) =>
  client.next((f): f is Extract<Frame, { type: T }> => f.type === type && "subscription" in f && f.subscription === subscription);

/** Subscribes `client` to the environment stream after `afterSequence`, and waits until it is synchronized. */
const watch = async (client: WireClient, afterSequence: number): Promise<string> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  await frame(client, subscription, "synchronized");
  return subscription;
};

/** Whether `f` is a `setup.result-changed` event on `subscription`. */
const isSetupNotice =
  (subscription: string) =>
  (f: Frame): f is EventFrame =>
    f.type === "event" && f.subscription === subscription && f.event.type === "setup.result-changed";

/** `environment.subscribe`'s snapshot, as a subscriber is sent it whose cursor is past the head. */
const snapshot = async (t: TestEnvironment, client: WireClient): Promise<ResultOf<"environment.subscribe">> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
  return registry["environment.subscribe"].result.parse((await frame(client, subscription, "snapshot")).payload);
};

/** The results of the `setup.result-changed` notices `client` has received on `subscription`, in order. */
const noticed = (client: WireClient, subscription: string): StepResult[] =>
  client.received.filter(isSetupNotice(subscription)).map((f) => {
    const notice = EnvironmentNotice.parse(f.event);
    if (notice.type !== "setup.result-changed") throw new Error(`${notice.type} is not setup.result-changed.`);
    return notice.payload;
  });

describe("setup.result-changed", () => {
  it("is appended with each step's first result, as system:setup on the environment stream, and a subscriber hears a change live", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    const first = await watch(client, 0);
    const done = { step: "account", state: "done", reason: "Set up here.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START };
    // In the order the checks answered.
    expect(noticed(client, first).map((result) => result.step).sort()).toEqual(["account", "appearance", "permissions"]);
    expect(noticed(client, first).find((result) => result.step === "account")).toEqual(done);
    for (const f of client.received.filter(isSetupNotice(first))) {
      expect(f.event).toMatchObject({ streamKind: "environment", streamId: t.env.id, type: "setup.result-changed", actor: { kind: "system", id: "setup" } });
    }

    const subscription = await watch(client, t.env.log.head());
    answers.account = { reason: "Work is signed out." };
    const result = await check(client, "account");
    const live = await client.next(isSetupNotice(subscription));
    expect(live.event).toMatchObject({ type: "setup.result-changed", actor: { kind: "system", id: "setup" } });
    expect(noticed(client, subscription)).toEqual([result]);
  });

  it("is appended once for a result that changed, and never for one that differs from the cached one only in when it was checked, which the cache takes", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    const subscription = await watch(client, t.env.log.head());
    const head = t.env.log.head();
    // The start pass noticed the first result; asked for again at once, nothing has changed.
    const first = await check(client, "permissions");
    expect(first).toMatchObject({ state: "done", checkedAt: MANUAL_CLOCK_START });

    // An hour on, nothing has changed: neither the hour's pass nor the check appends anything, and the cache holds the result with its new checked-at.
    t.clock.advance(HOUR);
    const same = await check(client, "permissions");
    expect(same).toEqual({ ...first, checkedAt: after(HOUR) });
    expect(appendedAfter(t.env.log, head)).toEqual([]);
    expect((await snapshot(t, client)).setup?.find((result) => result.step === "permissions")).toEqual(same);

    // Then the denylist loses its presets: the new result is noticed, once.
    answers.permissions = { reason: "The paths section of the denylist is missing ~/.aws; Restore puts it back." };
    t.clock.advance(MINUTE);
    const changed = await check(client, "permissions");
    expect(changed).toMatchObject({ state: "needs-attention", failing: ["permissions.denylist"], actions: ["restore"], checkedAt: after(HOUR + MINUTE) });
    await client.next(isSetupNotice(subscription));
    expect(noticed(client, subscription)).toEqual([changed]);
    expect(appendedAfter(t.env.log, head)).toEqual(["setup.result-changed"]);
  });

  const work = { action: "sign-in-again", kind: "account", id: "account-work", label: "Work" } as const;
  it.each([
    ["its line alone", { reason: "Work is signed out." }, { reason: "Work and Personal are signed out." }],
    ["the items its actions apply to alone", { reason: "An account is signed out.", targets: [work] }, { reason: "An account is signed out.", targets: [{ ...work, id: "account-personal", label: "Personal" }] }],
    ["what could not be checked", { reason: "Work is signed out." }, new Error("the account store is locked")],
  ] as const)("is appended for a result that differs from the cached one in %s", async (_what, before, later) => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    const subscription = await watch(client, t.env.log.head());
    answers.account = before;
    const first = await check(client, "account");
    answers.account = later;
    const second = await check(client, "account");
    expect(second).toMatchObject({ state: "needs-attention", checkedAt: first.checkedAt });
    expect(second).not.toEqual(first);
    const last = t.env.log.head();
    await client.next((f) => isSetupNotice(subscription)(f) && f.sequence === last);
    expect(noticed(client, subscription)).toEqual([first, second]);
  });
});

/** The status the snapshot of a test environment started `startedAt` after the manual clock's start carries. */
const freshStatus = (startedAt: number) =>
  ({
    readiness: "ready",
    // Busy for the idle window after its start (#445).
    activity: { state: "busy", reason: "recent-activity", busyUntil: after(startedAt + PRESET_IDLE_WINDOW_MS) },
    updatesManagedOutside: false,
    binding: { tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] },
  }) as const;

/** The environment's name, icon and colour the snapshot carries beside the results (#323): the look's own tests pin them. */
const lookOf = (t: TestEnvironment) => ({ name: t.env.name, icon: expect.any(String) as unknown, colour: expect.any(String) as unknown });

describe("environment.subscribe's snapshot", () => {
  it("carries every step's cached result as setup, in the registry's order, a step whose first check has not answered absent", async () => {
    const late = lateCheck();
    const t = await startTestEnvironment({
      setupSteps: {
        steps: [
          scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: [] }] }),
          scriptedStep("permissions", { stateChecks: [{ id: "permissions.denylist", holds: "The denylist holds its presets.", actions: ["restore"] }] }),
          scriptedStep("appearance"),
        ],
        stateChecks: {
          "account.late": late.checker,
          "permissions.denylist": () => {
            throw new Error("the denylist cannot be read");
          },
        },
      },
    });
    onCleanup(() => t.close());
    const client = await t.client();
    // The start pass is under way: Account's check waits on its late state check.
    await late.call(1);
    const [permissions, appearance] = (await snapshot(t, client)).setup ?? [];
    expect(permissions).toMatchObject({
      step: "permissions",
      state: "needs-attention",
      reason: "agent-harness could not finish checking this step. Choose Check again.",
      details: ["permissions.denylist: the denylist cannot be read"],
    });
    expect(appearance).toMatchObject({ step: "appearance", state: "done" });
    expect((await snapshot(t, client)).setup).toHaveLength(2);

    (await late.call(1)).answer(true);
    await t.env.setup.startPass;
    const account = { step: "account", state: "done", reason: "Set up here.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START };
    expect(await snapshot(t, client)).toEqual({ status: freshStatus(0), environment: lookOf(t), setup: [account, permissions, appearance] });
  });

  it("carries every registered step's result once the step registry's checks have run, in the milestone-1 order", async () => {
    const t = await start();
    const client = await t.client();
    const { results } = await client.request("setup.check", {});
    expect(results.map((result) => result.step)).toEqual(["account", "carry-over", "your-machines", "forges", "key-manager", "memory-bank", "skills", "instructions", "browser", "permissions", "appearance"]);
    expect((await snapshot(t, client)).setup).toEqual(results);
  });

  it("carries the cached results across a restart on the same data directory, and the start pass there, finding the same, appends nothing and moves their checked-at on", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    answers.account = { reason: "Work is signed out.", targets: [{ action: "sign-in-again", kind: "account", id: "account-work", label: "Work" }] };
    const { results } = await (await first.client()).request("setup.check", {});
    expect(results.map((result) => [result.step, result.state, result.checkedAt])).toEqual([
      ["account", "needs-attention", MANUAL_CLOCK_START],
      ["permissions", "done", MANUAL_CLOCK_START],
      ["appearance", "done", MANUAL_CLOCK_START],
    ]);
    await first.close();

    const second = await start({ dataDir, setupSteps, clock: manualClock(after(2 * HOUR)) });
    const client = await second.client();
    expect(await snapshot(second, client)).toEqual({ status: freshStatus(2 * HOUR), environment: lookOf(second), setup: results.map((result) => ({ ...result, checkedAt: after(2 * HOUR) })) });
    // Four notices at the first start (three first results, and Account's change), none at the second.
    const subscription = await watch(client, 0);
    expect(noticed(client, subscription)).toHaveLength(4);
  });

  it("is not what a check checks: the start pass after a restart answers what its state checks find now, and is noticed when that changed", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    const cursor = first.env.log.head();
    expect((await snapshot(first, await first.client())).setup?.map((result) => result.state)).toEqual(["done", "done", "done"]);
    await first.close();

    answers.permissions = { reason: "The paths section of the denylist is missing ~/.aws; Restore puts it back." };
    const second = await start({ dataDir, setupSteps });
    const client = await second.client();
    const subscription = await watch(client, cursor);
    const [changed] = noticed(client, subscription);
    expect(changed).toMatchObject({ step: "permissions", state: "needs-attention", failing: ["permissions.denylist"] });
    expect(noticed(client, subscription)).toEqual([changed]);
    expect((await snapshot(second, client)).setup?.[1]).toEqual(changed);
  });
});

describe("the setup subscription for a client", () => {
  it("replays setup.result-changed from a cursor, and a program paired with read alone reads the notices and the snapshot's setup", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const admin = await t.client();
    const cursor = t.env.log.head();
    answers.account = { reason: "Work is signed out." };
    const signedOut = await check(admin, "account");
    answers.account = true;
    t.clock.advance(MINUTE);
    const done = await check(admin, "account");

    const program = await t.client({ token: (await t.pair({ scopes: ["read"], kind: "program" })).token });
    expect(program.hello.scopes).toEqual(["read"]);
    const subscription = await watch(program, cursor);
    expect(noticed(program, subscription)).toEqual([signedOut, done]);
    expect((await snapshot(t, program)).setup?.[0]).toEqual(done);
  });

  it("is offered under the setup capability flag, in hello and the discovery document", async () => {
    const t = await start();
    expect((await t.client()).hello.capabilities).toContain("setup");
    const response = await fetch(`http://${t.address.host}:${t.address.port}${DISCOVERY_PATH}`);
    expect(DiscoveryDocument.parse(await response.json()).capabilities).toContain("setup");
  });
});

describe("the result cache", () => {
  it("counts a row this build cannot read, as another version's shape, as never checked: absent from the snapshot, and the next result noticed as a first", async () => {
    const { setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    const account = await check(client, "account");
    // The lower seam: a row with a state this build does not have, and one that is not JSON.
    const unreadable = { ...account, step: "permissions", state: "checking" };
    t.env.log.atomically((tx) => {
      t.env.log.setupResults.write(tx, "permissions", JSON.stringify(unreadable));
      t.env.log.setupResults.write(tx, "appearance", "{");
    });
    expect((await snapshot(t, client)).setup).toEqual([account]);

    const subscription = await watch(client, t.env.log.head());
    const permissions = await check(client, "permissions");
    await client.next(isSetupNotice(subscription));
    expect(noticed(client, subscription)).toEqual([permissions]);
    expect((await snapshot(t, client)).setup).toEqual([account, permissions]);
  });

  it("reads a row a newer version wrote in a vocabulary this build lacks, leaving out what it does not know, and notices a result that differs from the row as written (#693)", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    answers.permissions = { reason: "The paths section of the denylist is missing ~/.aws; Restore puts it back." };
    const first = await check(client, "permissions");
    // The lower seam: the row as a newer version, since rolled back from, wrote it, offering a verb this build's vocabulary lacks.
    t.env.log.atomically((tx) => t.env.log.setupResults.write(tx, "permissions", JSON.stringify({ ...first, actions: ["restore", "rotate-token"] })));
    expect((await snapshot(t, client)).setup?.find((result) => result.step === "permissions")).toEqual(first);

    // This build's check finds the same, without the verb: a client that heard the newer result is told it no longer holds.
    const subscription = await watch(client, t.env.log.head());
    const head = t.env.log.head();
    t.clock.advance(MINUTE);
    const again = await check(client, "permissions");
    expect(again).toEqual({ ...first, checkedAt: after(MINUTE) });
    expect(t.env.log.head()).toBe(head + 1);
    await client.next(isSetupNotice(subscription));
    expect(noticed(client, subscription)).toEqual([again]);
  });
});
