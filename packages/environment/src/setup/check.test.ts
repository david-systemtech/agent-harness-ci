import { STEP_REGISTRY, presetSettings, type RegisteredStep, type SettingsValues } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { checkStep, type DoneLine, type StateCheckers } from "./check.js";

/**
 * How one step's result is put together (ADR 0031; #141): its keys' value
 * checks, then its state checks, in the entry's order; done when all hold,
 * else needs attention naming each failure, with the failing checks'
 * actions once each.
 */

const AT = "2026-09-25T08:00:00.000Z";
const stepOf = (id: RegisteredStep["id"]): RegisteredStep => STEP_REGISTRY.find((step) => step.id === id) as RegisteredStep;

/** The step's check at `AT`, its state checks answering as `stateChecks` says, with no last good result, and the environment's line for it done when one is given. */
const check = (step: RegisteredStep, values: SettingsValues, stateChecks: StateCheckers, doneLine?: DoneLine) =>
  checkStep(step, { values, stateChecks, clock: manualClock(AT), checkedAt: AT, askedBy: "client", lastGood: undefined, ...(doneLine !== undefined && { doneLine }) });

const holding: StateCheckers = {
  "account.present": () => true,
  "account.signed-in": () => true,
  "carry-over.present": () => true,
  "carry-over.readable": () => true,
  "carry-over.last-import": () => true,
  "carry-over.default-account": () => true,
  "your-machines.not-root": () => true,
  "your-machines.release-channel": () => true,
  "your-machines.updates": () => true,
  "your-machines.host-updater": () => true,
  "your-machines.named": () => true,
  "your-machines.ready": () => true,
  "your-machines.lan": () => true,
  "forges.present": () => true,
  "forges.identity": () => true,
  "forges.reads": () => true,
  "forges.primary": () => true,
  "forges.gh": () => true,
  "forges.expiry": () => true,
  "forges.coverage": () => true,
  "key-manager.present": () => true,
  "key-manager.signed-in": () => true,
  "key-manager.reachable": () => true,
  "key-manager.run-tokens": () => true,
  "key-manager.cli": () => true,
  "memory-bank.present": () => true,
  "memory-bank.reachable": () => true,
  "memory-bank.manifest": () => true,
  "memory-bank.orientation": () => true,
  "memory-bank.owners": () => true,
  "memory-bank.landing": () => true,
  "instructions.orientation-renders": () => true,
  "skills.present": () => true,
  "skills.sources-synced": () => true,
  "skills.sources-yield": () => true,
  "skills.source-limit": () => true,
  "skills.own-directory": () => true,
  "browser.present": () => true,
  "browser.chrome-connected": () => true,
  "browser.extension-current": () => true,
  "permissions.containment": () => true,
  "permissions.denylist": () => true,
  "permissions.not-root": () => true,
  "appearance.contrast": () => true,
};

describe("a step's result", () => {
  it("is done when every check holds, its line the entry's one sentence of what was found", async () => {
    expect(await check(stepOf("permissions"), presetSettings(), holding)).toEqual({
      step: "permissions",
      state: "done",
      reason: "Containment and the denylist are set.",
      failing: [],
      actions: [],
      checkedAt: AT,
    });
    expect(await check(stepOf("browser"), presetSettings(), holding)).toMatchObject({ state: "done", reason: "Chrome is paired, connected and current." });
  });

  it("never makes a done step's line of its checks' conditions, whose alternatives say what would pass rather than what is there, on any registered step (#1698)", async () => {
    for (const step of STEP_REGISTRY) {
      const { state, reason } = await check(step, presetSettings(), holding);
      expect({ step: step.id, state, reason }).toEqual({ step: step.id, state: "done", reason: step.done });
      expect(reason, step.id).not.toMatch(/\bor\b/);
      for (const stateCheck of step.stateChecks) expect(reason, stateCheck.id).not.toContain(stateCheck.holds);
    }
  });

  it("says what the environment found when it gives a line for the step, the entry's sentence when it gives none or cannot read it", async () => {
    const found = "Past work found in /srv/source-data: 7 profiles. Not brought over yet.";
    expect(await check(stepOf("carry-over"), presetSettings(), holding, () => found)).toMatchObject({ state: "done", reason: found });
    expect(await check(stepOf("carry-over"), presetSettings(), holding, async () => undefined)).toMatchObject({ state: "done", reason: "Nothing is waiting to be brought over." });
    expect(await check(stepOf("carry-over"), presetSettings(), holding, async () => Promise.reject(new Error("EACCES")))).toMatchObject({ state: "done", reason: "Nothing is waiting to be brought over." });
    // A step that does not pass never asks for it.
    let asked = false;
    const failing = await check(stepOf("carry-over"), presetSettings(), { ...holding, "carry-over.readable": () => ({ reason: "A directory cannot be read." }) }, () => ((asked = true), found));
    expect([failing.state, asked]).toEqual(["needs-attention", false]);
  });

  it("adds what a passing check says it found after the step's line and leaves failure actions out", async () => {
    const stateChecks: StateCheckers = { ...holding, "permissions.denylist": async () => ({ holds: true, reason: "The denylist was deliberately emptied." }) };
    expect(await check(stepOf("permissions"), presetSettings(), stateChecks)).toMatchObject({
      state: "done",
      reason: "Containment and the denylist are set. The denylist was deliberately emptied.",
      failing: [],
      actions: [],
    });
    expect(await check(stepOf("permissions"), presetSettings(), {
      ...stateChecks, "permissions.not-root": () => ({ reason: "This environment runs as root." }),
    })).toMatchObject({ state: "needs-attention", reason: "This environment runs as root.", failing: ["permissions.not-root"] });
  });

  it("reports pending without failure actions while waiting for a scheduled read, and gives real failures precedence", async () => {
    const waiting: StateCheckers = { ...holding, "your-machines.release-channel": () => ({ pending: true, reason: "Waiting for the first release channel read." }) };
    expect(await check(stepOf("your-machines"), presetSettings(), waiting)).toMatchObject({ state: "pending", failing: [], actions: [] });
    expect(await check(stepOf("your-machines"), presetSettings(), {
      ...waiting, "your-machines.named": () => ({ reason: "The environment needs a name." }),
    })).toMatchObject({ state: "needs-attention", failing: ["your-machines.named"], reason: "The environment needs a name." });
  });

  it("keeps real failures visible when a skip check is pending", async () => {
    expect(await check(stepOf("forges"), presetSettings(), {
      ...holding,
      "forges.present": () => ({ pending: true, reason: "Waiting for forge accounts." }),
      "forges.identity": () => ({ reason: "The forge refused the credential." }),
    })).toMatchObject({ state: "needs-attention", failing: ["forges.identity"], reason: "The forge refused the credential.", actions: ["sign-in-again", "check-again"] });
  });

  it("needs attention naming every failure in the entry's order, the value checks first, with each failing check's actions once", async () => {
    const values = { ...presetSettings(), "permissions.parkedPrompt.ttl": "forever" } as unknown as ReturnType<typeof presetSettings>;
    const result = await check(stepOf("permissions"), values, {
      ...holding,
      "permissions.denylist": () => ({ reason: "The paths section is short." }),
      "permissions.not-root": () => ({ reason: "Root." }),
    });
    expect(result).toEqual({
      step: "permissions",
      state: "needs-attention",
      reason: "permissions.parkedPrompt.ttl does not hold a valid value. The paths section is short. Root.",
      failing: ["permissions.parkedPrompt.ttl", "permissions.denylist", "permissions.not-root"],
      actions: ["restore"],
      checkedAt: AT,
    });
  });

  it("needs attention when a state check throws, saying it could not check", async () => {
    const result = await check(stepOf("your-machines"), presetSettings(), {
      ...holding,
      "your-machines.not-root": () => {
        throw new Error("the log is closed");
      },
    });
    expect(result).toMatchObject({ state: "needs-attention", reason: "Could not check your-machines.not-root: the log is closed.", failing: ["your-machines.not-root"] });
  });
});
