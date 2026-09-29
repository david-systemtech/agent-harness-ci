import { DISCOVERY_PATH, DiscoveryDocument, EnvironmentNotice, registry, type EventFrame, type Frame, type ResultOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { lateCheck, scriptedStep } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { SetupSteps } from "./service.js";

/**
 * The result cache and ADR 0031's `setup` subscription through the primary
 * seam (the Set up specification, "Results, the cache and the
 * subscription"; #569): an in-process environment, restarted on one data
 * directory, driven by real clients over real WebSockets, with a registry
 * of scripted steps whose checks hold, fail or throw as the test says. What
 * is asserted is what a client sees: what `setup.check` answers, the
 * `setup.result-changed` notices on the environment stream, and
 * `environment.subscribe`'s snapshot; never the cache's table.
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
      scriptedStep("account", { stateChecks: [{ id: "account.signed-in", holds: "Every account is signed in.", actions: ["sign-in-again"] }] }),
      scriptedStep("permissions", { stateChecks: [{ id: "permissions.denylist", holds: "The denylist holds its presets.", actions: ["restore"] }] }),
      scriptedStep("appearance"),
    ],
    stateChecks: { "account.signed-in": () => answer(answers.account), "permissions.denylist": () => answer(answers.permissions) },
  };
  return { answers, setupSteps };
};

/** The one result `setup.check` answers for `step`. */
const check = async (client: WireClient, step: StepResult["step"]): Promise<StepResult> => {
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
  it("is appended with a step's first result, as system:setup on the environment stream, and a subscriber hears it live", async () => {
    const { setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    const subscription = await watch(client, t.env.log.head());

    const result = await check(client, "account");
    expect(result).toEqual({ step: "account", state: "done", reason: "Every account is signed in.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
    const live = await client.next(isSetupNotice(subscription));
    expect(live.event).toMatchObject({ streamKind: "environment", streamId: t.env.id, type: "setup.result-changed", actor: { kind: "system", id: "setup" } });
    expect(noticed(client, subscription)).toEqual([result]);
  });

  it("is appended once for a result that changed, and never for one that differs from the cached one only in when it was checked, which the cache takes", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    const subscription = await watch(client, t.env.log.head());
    const first = await check(client, "permissions");
    await client.next(isSetupNotice(subscription));

    // An hour on, nothing has changed: the check appends nothing, and the cache holds the result with its new checked-at.
    t.clock.advance(HOUR);
    const head = t.env.log.head();
    const same = await check(client, "permissions");
    expect(same).toEqual({ ...first, checkedAt: after(HOUR) });
    expect(t.env.log.head()).toBe(head);
    expect((await snapshot(t, client)).setup).toEqual([same]);

    // Then the denylist loses its presets: the new result is noticed, once.
    answers.permissions = { reason: "The paths section of the denylist is missing ~/.aws; Restore puts it back." };
    t.clock.advance(MINUTE);
    const changed = await check(client, "permissions");
    expect(changed).toMatchObject({ state: "needs-attention", failing: ["permissions.denylist"], actions: ["restore"], checkedAt: after(HOUR + MINUTE) });
    await client.next(isSetupNotice(subscription));
    expect(noticed(client, subscription)).toEqual([first, changed]);
    expect(t.env.log.head()).toBe(head + 1);
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

/** The status a fresh test environment's snapshot carries. */
const IDLE = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false } as const;

describe("environment.subscribe's snapshot", () => {
  it("carries every checked step's cached result as setup, in the registry's order, a step never checked absent", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const client = await t.client();
    expect(await snapshot(t, client)).toEqual({ status: IDLE, setup: [] });

    answers.permissions = new Error("the denylist cannot be read");
    const permissions = await check(client, "permissions");
    expect(permissions).toMatchObject({ state: "needs-attention", reason: "Could not check permissions.denylist: the denylist cannot be read." });
    t.clock.advance(MINUTE);
    const account = await check(client, "account");
    expect(await snapshot(t, client)).toEqual({ status: IDLE, setup: [account, permissions] });
  });

  it("carries the cached results after a restart on the same data directory, with their checked-at, and a first check there that finds the same appends nothing", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    answers.account = { reason: "Work is signed out.", targets: [{ action: "sign-in-again", kind: "account", id: "account-work", label: "Work" }] };
    first.clock.advance(HOUR);
    const { results } = await (await first.client()).request("setup.check", {});
    expect(results.map((result) => [result.step, result.state, result.checkedAt])).toEqual([
      ["account", "needs-attention", after(HOUR)],
      ["permissions", "done", after(HOUR)],
      ["appearance", "done", after(HOUR)],
    ]);
    await first.close();

    const second = await start({ dataDir, setupSteps, clock: manualClock(after(2 * HOUR)) });
    const client = await second.client();
    expect(await snapshot(second, client)).toEqual({ status: IDLE, setup: results });

    const head = second.env.log.head();
    expect(await check(client, "account")).toEqual({ ...results[0], checkedAt: after(2 * HOUR) });
    expect(second.env.log.head()).toBe(head);
  });

  it("is not what a check checks: a first check after a restart answers what its state checks find now, and is noticed when that changed", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const dataDir = `${tempDir()}/data`;
    const first = await start({ dataDir, setupSteps });
    const done = await check(await first.client(), "permissions");
    expect(done.state).toBe("done");
    await first.close();

    answers.permissions = { reason: "The paths section of the denylist is missing ~/.aws; Restore puts it back." };
    const second = await start({ dataDir, setupSteps });
    const client = await second.client();
    const subscription = await watch(client, second.env.log.head());
    const changed = await check(client, "permissions");
    expect(changed).toMatchObject({ state: "needs-attention", failing: ["permissions.denylist"] });
    await client.next(isSetupNotice(subscription));
    expect(noticed(client, subscription)).toEqual([changed]);
    expect((await snapshot(second, client)).setup).toEqual([changed]);
  });
});

describe("the setup subscription for a client", () => {
  it("replays setup.result-changed from a cursor, and a program paired with read alone reads the notices and the snapshot's setup", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await start({ setupSteps });
    const admin = await t.client();
    const cursor = t.env.log.head();
    const done = await check(admin, "account");
    answers.account = { reason: "Work is signed out." };
    t.clock.advance(MINUTE);
    const signedOut = await check(admin, "account");

    const program = await t.client({ token: (await t.pair({ scopes: ["read"], kind: "program" })).token });
    expect(program.hello.scopes).toEqual(["read"]);
    const subscription = await watch(program, cursor);
    expect(noticed(program, subscription)).toEqual([done, signedOut]);
    expect((await snapshot(t, program)).setup).toEqual([signedOut]);
  });

  it("is offered under the setup capability flag, in hello and the discovery document", async () => {
    const t = await start();
    expect((await t.client()).hello.capabilities).toContain("setup");
    const response = await fetch(`http://${t.address.host}:${t.address.port}${DISCOVERY_PATH}`);
    expect(DiscoveryDocument.parse(await response.json()).capabilities).toContain("setup");
  });
});

describe("the result cache", () => {
  it("holds the latest check's result: one from a check that started earlier and answered later goes to its caller, and is neither kept nor noticed", async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: ["check-again"] }] })],
        stateChecks: { "account.late": late.checker },
      },
    });
    const client = await t.client();
    const subscription = await watch(client, t.env.log.head());
    const earlier = check(client, "account");
    const earlierCall = await late.call(1);
    t.clock.advance(1_000);
    const later = check(client, "account");
    (await late.call(2)).answer(true);
    const latest = await later;
    expect(latest).toMatchObject({ state: "done", checkedAt: after(1_000) });

    earlierCall.answer({ reason: "The late check found a problem." });
    expect(await earlier).toMatchObject({ state: "needs-attention", checkedAt: MANUAL_CLOCK_START });
    expect((await snapshot(t, client)).setup).toEqual([latest]);
    expect(noticed(client, subscription)).toEqual([latest]);
  });
});
