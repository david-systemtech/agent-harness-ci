import { STEP_REGISTRY, presetSettings, type RegisteredStep, type SettingsValues } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { checkStep, type StateCheckers } from "./check.js";

/**
 * How one step's result is put together (ADR 0031; #141): its keys' value
 * checks, then its state checks, in the entry's order; done when all hold,
 * else needs attention naming each failure, with the failing checks'
 * actions once each.
 */

const AT = "2026-09-25T08:00:00.000Z";
const stepOf = (id: RegisteredStep["id"]): RegisteredStep => STEP_REGISTRY.find((step) => step.id === id) as RegisteredStep;

/** The step's check at `AT`, its state checks answering as `stateChecks` says, with no last good result. */
const check = (step: RegisteredStep, values: SettingsValues, stateChecks: StateCheckers) =>
  checkStep(step, { values, stateChecks, clock: manualClock(AT), checkedAt: AT, askedBy: "client", lastGood: undefined });

const holding: StateCheckers = {
  "account.present": () => true,
  "account.signed-in": () => true,
  "carry-over.present": () => true,
  "carry-over.readable": () => true,
  "carry-over.last-import": () => true,
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
  it("is done when every check holds, its line what they found", async () => {
    expect(await check(stepOf("permissions"), presetSettings(), holding)).toEqual({
      step: "permissions",
      state: "done",
      reason: "The containment default can be enforced here. Each denylist section holds its presets, or was emptied on purpose. The environment runs as a non-root user.",
      failing: [],
      actions: [],
      checkedAt: AT,
    });
    expect(await check(stepOf("browser"), presetSettings(), holding)).toMatchObject({ state: "done", reason: "A Chrome is paired with this environment. A paired Chrome is connected. Every paired Chrome last reported the shipped extension version." });
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
