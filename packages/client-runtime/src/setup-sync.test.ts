import { describe, expect, it } from "vitest";
import type { StateCheckAnswer } from "../../environment/src/permissions/step-checks.js";
import type { SetupSteps } from "../../environment/src/setup/service.js";
import { answeringCheck, scriptedStep } from "../../environment/test/setup-steps.js";
import { holds, useHarness } from "../test/harness.js";
import type { SetupView } from "./projections/setup.js";
import { stepLine } from "./setup/checklist.js";
import { MANUAL_CLOCK_START, inMemoryPlatform } from "./testing/in-memory-platform.js";
import { whenWords } from "./transcript/format.js";

/**
 * `projections.setup` against the in-process environment (#570; the
 * primary seam, docs/specs/client-runtime.md, "Testing Decisions"): real
 * sockets, the environment's own result cache and `setup` subscription
 * (#569), and a registry of scripted steps whose checks answer what the
 * test says. This client's check fills the projection; a check another
 * client runs turns it through the notice, with no call from here; a pass
 * that finds nothing new is silent, so a followed result reads unchanged
 * since its checked-at rather than older than its cadence (#671).
 */

const harness = useHarness();

/** Account and Permissions, each with one state check answering what the test last set, and Appearance with none. */
const scriptedRegistry = () => {
  const answers: { account: StateCheckAnswer; permissions: StateCheckAnswer } = { account: true, permissions: { reason: "The denylist lost its presets." } };
  const setupSteps: SetupSteps = {
    steps: [
      scriptedStep("account", { done: "Every account is signed in.", stateChecks: [{ id: "account.signed-in", holds: "Every account is signed in.", actions: ["sign-in-again"] }] }),
      scriptedStep("permissions", { done: "The denylist holds its presets.", stateChecks: [{ id: "permissions.denylist", holds: "The denylist holds its presets.", actions: ["restore"] }] }),
      scriptedStep("appearance"),
    ],
    stateChecks: { "account.signed-in": () => answers.account, "permissions.denylist": () => answers.permissions },
  };
  return { answers, setupSteps };
};

/** Each registered step's id, state and reason, and whether it is stale or pending. */
const registered = (view: SetupView) =>
  view.steps.flatMap((step) => (step.result === null ? [] : [{ id: step.id, state: step.result.state, reason: step.result.reason, stale: step.result.stale, pending: step.pending }]));

describe("projections.setup over the in-process environment", () => {
  it("fills from the snapshot of the environment's start pass and from this client's check, and turns with the notice when another client's check finds the denylist put right, with no call of its own", async () => {
    const { answers, setupSteps } = scriptedRegistry();
    const t = await harness.environment({ name: "desk", setupSteps });
    // The environment checks every step as it starts (#571).
    await t.env.setup.startPass;
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const setup = runtime.projections.setup(t.env.id);
    const seen: SetupView[] = [];
    const stop = setup.subscribe((view) => seen.push(view));
    harness.onCleanup(async () => stop());
    expect(setup.read().reach).toEqual({ status: "reachable" });
    const rows = [
      { id: "account", state: "done", reason: "Every account is signed in.", stale: false, pending: false },
      { id: "permissions", state: "needs-attention", reason: "The denylist lost its presets.", stale: false, pending: false },
      { id: "appearance", state: "done", reason: expect.any(String), stale: false, pending: false },
    ];
    expect(registered(await holds(setup, (view) => view.counts.registered === 3))).toEqual(rows);

    const answer = await runtime.setup.check(t.env.id);
    expect(answer).toMatchObject({ ok: true });
    expect(registered(setup.read())).toEqual(rows);
    expect(setup.read().counts).toEqual({ registered: 3, done: 2, needsAttention: 1, skipped: 0, attention: ["permissions"] });

    // The denylist put right, and checked from another client.
    answers.permissions = true;
    const other = await t.client();
    await other.request("setup.check", { step: "permissions" });
    const turned = await holds(setup, (view) => view.counts.needsAttention === 0);
    expect(registered(turned).find((row) => row.id === "permissions")).toEqual({
      id: "permissions",
      state: "done",
      reason: "The denylist holds its presets.",
      stale: false,
      pending: false,
    });
    expect(turned.counts).toEqual({ registered: 3, done: 3, needsAttention: 0, skipped: 0, attention: [] });
    expect(seen.some((view) => view.steps.some((step) => step.pending))).toBe(false);
  });

  it("reads a stable step a pass re-checked with nothing new as unchanged since the checked-at this client heard, never older than its cadence, though the pass appended nothing (#671)", async () => {
    const account = answeringCheck();
    const permissions = answeringCheck();
    permissions.answer({ reason: "The denylist lost its presets." });
    const setupSteps: SetupSteps = {
      steps: [
        scriptedStep("account", { done: "Every account is signed in.", stateChecks: [{ id: "account.signed-in", holds: "Every account is signed in.", actions: ["sign-in-again"] }] }),
        scriptedStep("permissions", { done: "The denylist holds its presets.", stateChecks: [{ id: "permissions.denylist", holds: "The denylist holds its presets.", actions: ["restore"] }] }),
      ],
      stateChecks: { "account.signed-in": account.checker, "permissions.denylist": permissions.checker },
    };
    const t = await harness.environment({ name: "desk", setupSteps });
    await t.env.setup.startPass;
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const setup = runtime.projections.setup(t.env.id);
    const stop = setup.subscribe(() => undefined);
    harness.onCleanup(async () => stop());
    await holds(setup, (view) => view.counts.registered === 2);

    // An hour and a minute on, as this client tells the time. Its clock moves first: its watchdog, armed by the
    // environment's first ping, would end a socket whose environment's clock then stood still.
    platform.clock.advance(61 * 60_000);
    // The environment's hour passes: its cadence checks Account again, which finds nothing new, so nothing is appended.
    t.clock.advance(60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(account.calls()).toBe(2);

    // The denylist put right, and checked from another client: its notice comes after anything the pass appended.
    permissions.answer(true);
    const other = await t.client();
    await other.request("setup.check", { step: "permissions" });
    const view = await holds(setup, (seen) => seen.counts.needsAttention === 0);
    const signedIn = view.steps.find((step) => step.id === "account");
    expect(signedIn?.result).toMatchObject({ checkedAt: MANUAL_CLOCK_START, asked: false, olderThanCadence: false, stale: false });
    const now = runtime.environmentNow(t.env.id);
    expect(signedIn === undefined ? undefined : stepLine(signedIn, now)).toBe(`Every account is signed in. (unchanged since ${whenWords(MANUAL_CLOCK_START, now)})`);
  });
});
