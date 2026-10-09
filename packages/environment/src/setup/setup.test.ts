import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { DEFAULT_THEME, registry, type ParamsOf, type RegisteredStepId, type ResponseOf, type StepResult, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { bubblewrapProbe, brokenProbe } from "../../test/containment.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";
import { lateCheck, scriptedStep, type LateCheck } from "../../test/setup-steps.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import { machinePointedAt } from "../state-import/source/folders.js";
import type { StateChecker } from "./check.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `setup.check` through the primary seam (ADR 0031; permissions spec, "The
 * Permissions step"; #141): an in-process environment on a scripted
 * containment probe, driven by a real client over a real WebSocket. What is
 * asserted is what a client sees: each step's state, its line, the checks
 * that failed and the actions offered. Steps of the tests' own, whose state
 * checks answer when the test says, drive the budgets on the manual clock,
 * the last good result and the skip check (#308); each such test first lets
 * the start pass (#571) end, answering its first calls, so the checks it
 * asks for are the later ones.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

type Command = "permissions.settings.set" | "permissions.denylist.set" | "permissions.denylist.restorePresets";

/** Sends a command with a fresh command id; resolves with its response, checked against its schema. */
const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** The one result `setup.check` answers for `step`. */
const check = async (client: WireClient, step: RegisteredStepId): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step });
  expect(results.map((result) => result.step)).toEqual([step]);
  return results[0] as StepResult;
};

describe("setup.check", () => {
  it("checks every registered step on a fresh environment, in the milestone-1 order: each done but Your machines, whose check reads the release channel again for a client and finds it unreachable here (#1848), and Carry over, Forges, Key manager, Memory bank, Skills and Browser, skipped with nothing to carry, no forge account, no connection, no bank and no paired Chrome, with its line and the environment's clock", async () => {
    const t = await start();
    const client = await t.client();
    const { results } = await client.request("setup.check", {});
    expect(results.map((result) => [result.step, result.state, result.failing, result.actions])).toEqual([
      ["account", "done", [], []],
      ["carry-over", "skipped", [], []],
      ["your-machines", "needs-attention", ["your-machines.release-channel"], ["check-again"]],
      ["forges", "skipped", [], []],
      ["key-manager", "skipped", [], []],
      ["memory-bank", "skipped", [], []],
      ["skills", "skipped", [], []],
      ["instructions", "done", [], []],
      ["browser", "skipped", [], []],
      ["permissions", "done", [], []],
      ["appearance", "done", [], []],
    ]);
    for (const result of results) expect(result.checkedAt, result.step).toBe(MANUAL_CLOCK_START);
    const permissions = results.find((result) => result.step === "permissions");
    // The default is off on a machine whose probe cannot enforce workspace: the line says so, never that agents are sandboxed (#1698).
    expect(permissions?.reason).toBe("Set. Agents are not sandboxed.");
  });

  it("checks one step when asked for it, at the time it runs", async () => {
    const t = await start();
    const client = await t.client();
    t.clock.advance(90_000);
    const result = await check(client, "appearance");
    expect(result).toMatchObject({ state: "done", checkedAt: new Date(Date.parse(MANUAL_CLOCK_START) + 90_000).toISOString() });
  });

  it("needs read, and refuses a step that is not registered", async () => {
    const t = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect((await reader.request("setup.check", { step: "permissions" })).results).toHaveLength(1);
    const driver = await t.client({ token: (await t.pair({ scopes: ["runs:drive"] })).token });
    expect(await refusal(driver.request("setup.check", {}))).toMatchObject({ code: "forbidden", data: { scope: "read" } });
    expect(await refusal(reader.request("setup.check", { step: "unknown-step" } as never))).toMatchObject({ code: "invalid_params" });
  });
});

describe("the Your machines step's health line", () => {
  it("reports not-root from what permissions.settings.get answers as isRoot, and when done says the computer is ready by its name and its updates, its version and reach in details (#1698, #1836)", async () => {
    const t = await start({ harnessVersion: "0.1.3" });
    const client = await t.client();
    expect((await client.request("permissions.settings.get", {})).isRoot).toBe(false);
    // With auto-update off, the release channel's check holds without a check (#346).
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.autoUpdate": false } });
    const name = "Desk";
    await client.request("environment.rename", { commandId: randomUUID(), name });
    expect(await check(client, "your-machines")).toMatchObject({
      state: "done",
      reason: `${name} is ready. Automatic updates are off.`,
      details: ["Version: 0.1.3", "Updates: off", "Reachable from: this computer only"],
      failing: [],
    });
  });
});

describe("each step's line when done (#1698)", () => {
  it("says what was found in plain words, never the checks' conditions joined, Carry over saying what a source data folder nothing was brought over from holds, its path in details (#1836)", async () => {
    const dataFolder = tempDir();
    writeFileSync(join(dataFolder, "profiles.json"), JSON.stringify({ version: 1, profiles: ["a", "b", "c"].map((id) => ({ id, providerId: "claude", configDir: join(dataFolder, id) })) }));
    writeFileSync(join(dataFolder, "memory-banks.json"), JSON.stringify({ version: 1, banks: [{ slug: "notebook" }], default: "notebook" }));
    const t = await start({ harnessVersion: "0.1.3", stateImportSource: machinePointedAt({ dataFolder, home: tempDir() }) });
    const client = await t.client();
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.autoUpdate": false } });
    const name = "Desk";
    await client.request("environment.rename", { commandId: randomUUID(), name });
    const { results } = await client.request("setup.check", {});
    const done = results.filter((result) => result.state === "done");
    expect(Object.fromEntries(done.map((result) => [result.step, result.reason]))).toEqual({
      account: "claude-max is signed in.",
      "carry-over": "Found earlier work you can bring over: 3 profiles, 1 bank.",
      "your-machines": `${name} is ready. Automatic updates are off.`,
      instructions: "Agents get your notes and a summary of this computer.",
      permissions: "Set. Agents are not sandboxed.",
      appearance: "Your theme is easy to read.",
    });
    expect(done.find((result) => result.step === "carry-over")?.details).toEqual([`Folder: ${dataFolder}`]);
    for (const result of results.filter((each) => each.state === "done")) expect(result.reason, result.step).not.toMatch(/\bor\b/);
  });
});

describe("the Permissions step's check", () => {
  it("is done on a fresh environment whose probe finds no mechanism: the preset default is off there, which is enforceable", async () => {
    const t = await start();
    const client = await t.client();
    expect((await client.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe("off");
    expect(await check(client, "permissions")).toMatchObject({ state: "done", reason: "Set. Agents are not sandboxed.", details: ["permissions.containment.default: off"] });
  });

  it("needs attention when the default is workspace and the probe finds no mechanism, naming containment with the Linux package hint", async () => {
    const dataDir = `${tempDir()}/data`;
    const first = await startTestEnvironment({ dataDir, containment: bubblewrapProbe() });
    const admin = await first.client();
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } })).receipt).toMatchObject({ status: "accepted" });
    expect(await check(admin, "permissions")).toMatchObject({ state: "done", reason: "Set. Agents stay inside the project folder." });
    await first.close();

    // The same environment started again on a machine where bubblewrap is gone: the stored default no longer holds.
    const second = await start({ dataDir });
    const client = await second.client();
    const result = await check(client, "permissions");
    expect(result).toMatchObject({ state: "needs-attention", failing: ["permissions.containment"], actions: [] });
    expect(result.reason).toContain("The containment default workspace cannot be enforced here: ");
    expect(result.reason).toContain("bubblewrap is not installed");
    expect(result.reason).toContain("install the bubblewrap and socat packages (sudo apt-get install bubblewrap socat)");
    expect(result.reason).toContain("on Ubuntu 24.04 and later");
    expect(result.reason).toContain("/etc/apparmor.d/bwrap");
    expect(result.reason).not.toMatch(/\n/);
    // The Your machines step's not-root line is not what fails.
    expect((await check(client, "your-machines")).failing).not.toContain("your-machines.not-root");
  });

  it("names the container's seccomp profile beside the package hint when that is what refused bubblewrap", async () => {
    const dataDir = `${tempDir()}/data`;
    const first = await startTestEnvironment({ dataDir, containment: bubblewrapProbe() });
    await send(await first.client(), "permissions.settings.set", { values: { "permissions.containment.default": "workspace-no-network" } });
    await first.close();
    const second = await start({ dataDir, containment: brokenProbe() });
    const result = await check(await second.client(), "permissions");
    expect(result).toMatchObject({ state: "needs-attention", failing: ["permissions.containment"] });
    expect(result.reason).toContain("The containment default workspace-no-network cannot be enforced here: ");
    expect(result.reason).toContain("bubblewrap and socat");
    expect(result.reason).toContain("a seccomp profile that allows unshare(CLONE_NEWUSER)");
  });

  it("needs attention when a section is missing presets, naming them, with Restore; restoring the presets makes it done", async () => {
    const t = await start();
    const admin = await t.client();
    const { denylist } = await admin.request("permissions.denylist.get", {});
    const paths = denylist.paths.filter((entry) => entry.pattern !== "~/.aws" && entry.pattern !== "~/.kube");
    await send(admin, "permissions.denylist.set", { sections: { paths } });
    const result = await check(admin, "permissions");
    expect(result).toMatchObject({ state: "needs-attention", failing: ["permissions.denylist"], actions: ["restore"] });
    expect(result.reason).toBe("The paths section of the denylist is missing 2 of its presets (~/.aws, ~/.kube); Restore puts them back.");

    await send(admin, "permissions.denylist.restorePresets", {});
    expect((await check(admin, "permissions")).state).toBe("done");
  });

  it("stays done when a person empties a section on purpose, or disables and edits presets, which the section still holds", async () => {
    const t = await start();
    const admin = await t.client();
    const { denylist } = await admin.request("permissions.denylist.get", {});
    await send(admin, "permissions.denylist.set", {
      sections: {
        browserDomains: [],
        commandPatterns: denylist.commandPatterns.map((entry) => ({ ...entry, enabled: false })),
        paths: denylist.paths.map((entry) => (entry.pattern === "~/.aws" ? { ...entry, pattern: "~/.aws/credentials" } : entry)),
      },
    });
    expect((await admin.request("permissions.denylist.get", {})).denylist.browserDomains).toEqual([]);
    // Its line names the section the person emptied rather than saying the denylist is whole (#1698).
    expect(await check(admin, "permissions")).toMatchObject({ state: "done", failing: [], reason: "Set. Agents are not sandboxed. You emptied the browser domains always-ask list." });
  });

  it("is never skipped, even on a fresh environment where Forges, with no forge account, is", async () => {
    const t = await start();
    const client = await t.client();
    const { results } = await client.request("setup.check", {});
    const stateOf = (step: StepResult["step"]) => results.find((result) => result.step === step)?.state;
    expect([stateOf("permissions"), stateOf("forges")]).toEqual(["done", "skipped"]);
  });
});

describe("the Appearance step's check (ADR 0023; #391)", () => {
  /** The preset with some seeds replaced, under another name. */
  const themed = (name: string, seeds: Partial<Theme["seeds"]>): Theme => ({ name, seeds: { ...DEFAULT_THEME.seeds, ...seeds } });
  const setTheme = async (client: WireClient, theme: Theme) => {
    const { receipt } = await client.request("settings.update", { commandId: randomUUID(), values: { "appearance.theme": theme } });
    expect(receipt.status).toBe("accepted");
  };

  it("is done on the preset theme, both ladders meeting the rules with no seed clamped", async () => {
    const t = await start();
    const client = await t.client();
    expect((await client.request("settings.get", { keys: ["appearance.theme"] })).values["appearance.theme"]).toEqual(DEFAULT_THEME);
    expect(await check(client, "appearance")).toMatchObject({
      state: "done",
      reason: "Your theme is easy to read.",
      failing: [],
      actions: [],
    });
  });

  it("needs attention on a theme built to fail, naming each clamped seed with the rule and the ladders, and offers Restore", async () => {
    const t = await start();
    const client = await t.client();
    // A red accent cannot hold 3:1 as a fill on the dark ground where its role puts it; the danger hue is moved clear of it.
    await setTheme(client, themed("Signal", { accent: { hue: 0, chroma: 0.21 }, danger: { hue: 40, chroma: 0.15 } }));
    expect(await check(client, "appearance")).toMatchObject({
      state: "needs-attention",
      reason: 'Some colours in Signal were adjusted so text stays readable.',
      details: ["accent (visibility of controls, Dark mode)"],
      failing: ["appearance.contrast"],
      actions: ["restore"],
    });

    // Chromas no screen shows, on two seeds: each is named once, in the seeds' order, its rule in both ladders.
    await setTheme(client, themed("Loud", { success: { hue: 150, chroma: 0.4 }, accent: { hue: 264, chroma: 0.4 } }));
    expect(await check(client, "appearance")).toMatchObject({
      reason: "Some colours in Loud were adjusted so text stays readable.",
      details: [
        "accent (screen colour limits, Light and Dark mode)",
        "success (screen colour limits, Light and Dark mode)",
      ],
    });

    // A tinted canvas: one seed, two rules.
    await setTheme(client, themed("Olive", { canvas: { hue: 121, chroma: 0.15 } }));
    expect(await check(client, "appearance")).toMatchObject({
      reason: "Some colours in Olive were adjusted so text stays readable.",
      details: ["canvas (screen colour limits, Light and Dark mode; visibility of controls, Light mode)"],
    });
  });

  it("is done again once Restore has written the preset theme back through settings.update", async () => {
    const t = await start();
    const client = await t.client();
    await setTheme(client, themed("Ember", { accent: { hue: 55, chroma: 0.19 } }));
    expect((await check(client, "appearance")).failing).toEqual(["appearance.contrast"]);
    await setTheme(client, DEFAULT_THEME);
    expect((await check(client, "appearance")).state).toBe("done");
  });
});

/** Resolves once every promise an answer settles has run: one turn of the event loop, whatever the wall clock. */
const answersSettled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** Lets the environment's start pass (#571) end, each late check's first call answered as given, before the test asks for its own checks. */
const startPassAnswered = async (t: TestEnvironment, ...answers: readonly (readonly [LateCheck, StateCheckAnswer])[]): Promise<void> => {
  for (const [late, answer] of answers) (await late.call(1)).answer(answer);
  await t.env.setup.startPass;
};

describe("setup.check on steps whose state checks answer late (#308)", () => {
  it("awaits a state check that answers asynchronously, and takes what it answers", async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: ["check-again"] }] })],
        stateChecks: { "account.late": late.checker },
      },
    });
    await startPassAnswered(t, [late, true]);
    const client = await t.client();
    const first = check(client, "account");
    (await late.call(2)).answer({ reason: "The late check found a problem." });
    expect(await first).toEqual({
      step: "account",
      state: "needs-attention",
      reason: "The late check found a problem.",
      failing: ["account.late"],
      actions: ["check-again"],
      checkedAt: MANUAL_CLOCK_START,
    });
    const second = check(client, "account");
    (await late.call(3)).answer(true);
    expect(await second).toEqual({ step: "account", state: "done", reason: "Set up here.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
  });

  it("answers needs attention with check-again past the step's budget, whatever the check answers later, and never before it", async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: [] }] })],
        stateChecks: { "account.late": late.checker },
      },
    });
    await startPassAnswered(t, [late, { reason: "The late check found a problem." }]);
    const client = await t.client();

    const first = check(client, "account");
    await late.call(2);
    t.clock.advance(4_999);
    (await late.call(2)).answer(true);
    expect(await first).toMatchObject({ state: "done", checkedAt: MANUAL_CLOCK_START });

    const second = check(client, "account");
    const call = await late.call(3);
    t.clock.advance(5_000);
    const timedOut = await second;
    call.answer({ reason: "Too late to count." });
    expect(timedOut).toEqual({
      step: "account",
      state: "needs-attention",
      reason: "Checking took too long. Choose Check again.",
      details: ["Stopped after 5 seconds."],
      failing: ["account.late"],
      actions: ["check-again"],
      checkedAt: after(4_999),
      lastGood: { state: "done", reason: "Set up here.", checkedAt: MANUAL_CLOCK_START },
    });
  });

  it.each([
    ["local", 5_000, "Stopped after 5 seconds."],
    ["network", 10_000, "Stopped after 10 seconds."],
    ["git", 30_000, "Stopped after 30 seconds."],
  ] as const)("times a step of the %s budget class out at its seconds and never before, the line saying it took too long, its details naming them", async (budget, ms, stopped) => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { budget, stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: [] }] })],
        stateChecks: { "account.late": late.checker },
      },
    });
    await startPassAnswered(t, [late, true]);
    const client = await t.client();
    const inTime = check(client, "account");
    const first = await late.call(2);
    t.clock.advance(ms - 1);
    first.answer(true);
    expect(await inTime).toMatchObject({ state: "done" });

    const timedOut = check(client, "account");
    await late.call(3);
    t.clock.advance(ms);
    expect(await timedOut).toMatchObject({
      state: "needs-attention",
      reason: "Checking took too long. Choose Check again.",
      details: [stopped],
      failing: ["account.late"],
      actions: ["check-again"],
    });
  });

  it("carries no last good result on a timeout when none is cached, the cached result needing attention with none, and a late answer that holds does not become one", async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [scriptedStep("account", { stateChecks: [{ id: "account.late", holds: "The late check holds.", actions: [] }] })],
        stateChecks: { "account.late": late.checker },
      },
    });
    await startPassAnswered(t, [late, { reason: "The late check found a problem." }]);
    const client = await t.client();
    const first = check(client, "account");
    const call = await late.call(2);
    t.clock.advance(5_000);
    const result = await first;
    expect(result).toMatchObject({ state: "needs-attention", reason: "Checking took too long. Choose Check again." });
    expect(result).not.toHaveProperty("lastGood");

    call.answer(true);
    const second = check(client, "account");
    await late.call(3);
    t.clock.advance(5_000);
    expect(await second).not.toHaveProperty("lastGood");
  });

  it("keeps the last good result beneath a timeout: the latest that passed, skipped as well as done, with its state, line and checked-at", async () => {
    const present = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("account", {
            skippable: true,
            skip: "account.present",
            stateChecks: [{ id: "account.present", holds: "An account is added.", actions: [] }],
          }),
        ],
        stateChecks: { "account.present": present.checker },
      },
    });
    await startPassAnswered(t, [present, true]);
    const client = await t.client();
    const skipped = check(client, "account");
    (await present.call(2)).answer({ reason: "No account is added." });
    expect(await skipped).toMatchObject({ state: "skipped", reason: "No account is added." });

    t.clock.advance(60_000);
    const failing = check(client, "account");
    (await present.call(3)).fail(new Error("the store is locked"));
    expect(await failing).toMatchObject({
      state: "needs-attention",
      reason: "agent-harness could not finish checking this step. Choose Check again.",
      details: ["account.present: the store is locked"],
      lastGood: { state: "skipped", reason: "No account is added.", checkedAt: MANUAL_CLOCK_START },
    });

    t.clock.advance(60_000);
    const done = check(client, "account");
    (await present.call(4)).answer(true);
    expect(await done).toMatchObject({ state: "done", checkedAt: after(120_000) });

    const timedOut = check(client, "account");
    await present.call(5);
    t.clock.advance(5_000);
    expect((await timedOut).lastGood).toEqual({ state: "done", reason: "Set up here.", checkedAt: after(120_000) });
  });

  it("checks every step at once when asked for none, each within its own budget, and answers in the registry's order", async () => {
    const slow = lateCheck();
    const quick = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("account", { budget: "network", stateChecks: [{ id: "account.slow", holds: "The slow check holds.", actions: [] }] }),
          scriptedStep("your-machines", { stateChecks: [{ id: "your-machines.quick", holds: "The quick check holds.", actions: [] }] }),
          scriptedStep("appearance"),
        ],
        stateChecks: { "account.slow": slow.checker, "your-machines.quick": quick.checker },
      },
    });
    await startPassAnswered(t, [slow, true], [quick, true]);
    const client = await t.client();

    const first = client.request("setup.check", {});
    const [slowCall] = await Promise.all([slow.call(2), quick.call(2)]);
    t.clock.advance(5_000);
    slowCall.answer(true);
    expect((await first).results.map((result) => [result.step, result.state, result.reason])).toEqual([
      ["account", "done", "Set up here."],
      ["your-machines", "needs-attention", "Checking took too long. Choose Check again."],
      ["appearance", "done", "Set up here."],
    ]);

    const second = client.request("setup.check", {});
    const [, quickCall] = await Promise.all([slow.call(3), quick.call(3)]);
    quickCall.answer(true);
    await answersSettled();
    t.clock.advance(10_000);
    expect((await second).results.map((result) => [result.step, result.state, result.reason])).toEqual([
      ["account", "needs-attention", "Checking took too long. Choose Check again."],
      ["your-machines", "done", "Set up here."],
      ["appearance", "done", "Set up here."],
    ]);
  });

  it("answers needs attention saying it could not check when a state check rejects, as when one throws", async () => {
    const late = lateCheck();
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("permissions", {
            stateChecks: [
              { id: "permissions.late", holds: "The late check holds.", actions: ["restore"] },
              { id: "permissions.throws", holds: "The throwing check holds.", actions: [] },
            ],
          }),
        ],
        stateChecks: {
          "permissions.late": late.checker,
          "permissions.throws": () => {
            throw new Error("the log is closed.");
          },
        },
      },
    });
    await startPassAnswered(t, [late, true]);
    const client = await t.client();
    const result = check(client, "permissions");
    (await late.call(2)).fail(new Error("the probe went away"));
    expect(await result).toEqual({
      step: "permissions",
      state: "needs-attention",
      reason: "agent-harness could not finish checking this step. Choose Check again.",
      details: ["permissions.late: the probe went away", "permissions.throws: the log is closed"],
      failing: ["permissions.late", "permissions.throws"],
      actions: ["check-again"],
      checkedAt: MANUAL_CLOCK_START,
    });
  });
});

describe("a skippable step's skip check (#308)", () => {
  const skippable = () => {
    const present = lateCheck();
    const other = lateCheck();
    const setupSteps = {
      steps: [
        scriptedStep("your-machines", {
          skippable: true,
          skip: "your-machines.present",
          stateChecks: [
            { id: "your-machines.present", holds: "A machine is set up here.", actions: [] },
            { id: "your-machines.other", holds: "The other check holds.", actions: ["check-again" as const] },
          ],
        }),
      ],
      stateChecks: { "your-machines.present": present.checker, "your-machines.other": other.checker },
    };
    return { present, other, setupSteps };
  };

  it("answers skipped with the skip check's line when it fails, running no other check", async () => {
    const { present, other, setupSteps } = skippable();
    const t = await start({ setupSteps });
    await startPassAnswered(t, [present, { reason: "Nothing is set up here." }]);
    const result = check(await t.client(), "your-machines");
    (await present.call(2)).answer({ reason: "Nothing is set up here." });
    expect(await result).toEqual({ step: "your-machines", state: "skipped", reason: "Nothing is set up here.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
    expect(other.calls()).toBe(0);
  });

  it("runs the other checks when it holds, the step then done or needing attention", async () => {
    const { present, other, setupSteps } = skippable();
    const t = await start({ setupSteps });
    await startPassAnswered(t, [present, { reason: "Nothing is set up here." }]);
    const client = await t.client();
    const done = check(client, "your-machines");
    (await present.call(2)).answer(true);
    (await other.call(1)).answer(true);
    expect(await done).toMatchObject({ state: "done", reason: "Set up here." });

    const failing = check(client, "your-machines");
    (await present.call(3)).answer(true);
    (await other.call(2)).answer({ reason: "The other check fails." });
    expect(await failing).toMatchObject({ state: "needs-attention", reason: "The other check fails.", failing: ["your-machines.other"], actions: ["check-again"] });
  });

  it("needs attention, never skipped, when the skip check could not check or timed out, naming it", async () => {
    const { present, other, setupSteps } = skippable();
    const t = await start({ setupSteps });
    await startPassAnswered(t, [present, { reason: "Nothing is set up here." }]);
    const client = await t.client();
    const rejected = check(client, "your-machines");
    (await present.call(2)).fail(new Error("the store is locked"));
    expect(await rejected).toMatchObject({
      state: "needs-attention",
      reason: "agent-harness could not finish checking this step. Choose Check again.",
      details: ["your-machines.present: the store is locked"],
      failing: ["your-machines.present"],
    });

    const timedOut = check(client, "your-machines");
    await present.call(3);
    t.clock.advance(5_000);
    expect(await timedOut).toMatchObject({ state: "needs-attention", reason: "Checking took too long. Choose Check again.", failing: ["your-machines.present"], actions: ["check-again"] });
    expect(other.calls()).toBe(0);
  });
});

describe("the items a result's actions apply to (#568)", () => {
  const work = { action: "sign-in-again", kind: "account", id: "account-work", label: "Work" } as const;
  const personal = { ...work, id: "account-personal", label: "Personal" } as const;
  const accountSteps = (checks: { readonly [id: string]: StateChecker }) => ({
    steps: [
      scriptedStep("account", {
        stateChecks: [
          { id: "account.signed-in", holds: "All your accounts are signed in.", actions: ["sign-in-again" as const] },
          { id: "account.sources", holds: "Every source is pulled.", actions: ["pull-now" as const, "sign-in-again" as const] },
        ],
      }),
    ],
    stateChecks: checks,
  });

  it("carries the targets the failing checks name, each with the action it serves, in the entry's order and each once", async () => {
    const source = { action: "pull-now", kind: "skill-source", id: "source-1", label: "team-skills" } as const;
    const t = await start({
      setupSteps: accountSteps({
        "account.signed-in": () => ({ reason: "Work and Personal are signed out.", targets: [work, personal] }),
        "account.sources": () => ({ reason: "team-skills has not pulled, and Work cannot reach it.", targets: [source, work] }),
      }),
    });
    expect(await check(await t.client(), "account")).toEqual({
      step: "account",
      state: "needs-attention",
      reason: "Work and Personal are signed out. team-skills has not pulled, and Work cannot reach it.",
      failing: ["account.signed-in", "account.sources"],
      actions: ["sign-in-again", "pull-now"],
      targets: [work, personal, source],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("carries no targets when no failing check names one, when the step is done, or for an action the check does not offer", async () => {
    let signedIn = false;
    const t = await start({
      setupSteps: accountSteps({
        "account.signed-in": () => signedIn || { reason: "Work is signed out.", targets: [{ ...work, action: "check-again" }] },
        "account.sources": () => true,
      }),
    });
    const client = await t.client();
    const failing = await check(client, "account");
    expect(failing).toMatchObject({ state: "needs-attention", failing: ["account.signed-in"], actions: ["sign-in-again"] });
    expect(failing).not.toHaveProperty("targets");
    signedIn = true;
    const done = await check(client, "account");
    expect(done.state).toBe("done");
    expect(done).not.toHaveProperty("targets");
  });

  it("carries none on a skipped step, whatever its skip check named", async () => {
    const t = await start({
      setupSteps: {
        steps: [
          scriptedStep("account", {
            skippable: true,
            skip: "account.present",
            stateChecks: [{ id: "account.present", holds: "An account is added.", actions: ["sign-in-again"] }],
          }),
        ],
        stateChecks: { "account.present": () => ({ reason: "No account is added.", targets: [work] }) },
      },
    });
    const result = await check(await t.client(), "account");
    expect(result).toMatchObject({ state: "skipped", reason: "No account is added.", actions: [] });
    expect(result).not.toHaveProperty("targets");
  });
});
