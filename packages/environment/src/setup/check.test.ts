import { STEP_REGISTRY, presetSettings, type RegisteredStep } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { checkStep, type StateCheckers } from "./check.js";

/**
 * How one step's result is put together (ADR 0031; #141): its keys' value
 * checks, then its state checks, in the entry's order; done when all hold,
 * else needs attention naming each failure, with the failing checks'
 * actions once each.
 */

const AT = "2026-09-25T08:00:00.000Z";
const stepOf = (id: RegisteredStep["id"]): RegisteredStep => STEP_REGISTRY.find((step) => step.id === id) as RegisteredStep;

const holding: StateCheckers = {
  "your-machines.not-root": () => true,
  "your-machines.release-channel": () => true,
  "permissions.containment": () => true,
  "permissions.denylist": () => true,
  "permissions.not-root": () => true,
};

describe("a step's result", () => {
  it("is done when every check holds, its line what they found", () => {
    expect(checkStep(stepOf("permissions"), presetSettings(), holding, AT)).toEqual({
      step: "permissions",
      state: "done",
      reason: "The containment default can be enforced here. Each denylist section holds its presets, or was emptied on purpose. The environment runs as a non-root user.",
      failing: [],
      actions: [],
      checkedAt: AT,
    });
    expect(checkStep(stepOf("appearance"), presetSettings(), holding, AT)).toMatchObject({ state: "done", reason: "Every setting it writes holds a valid value." });
  });

  it("needs attention naming every failure in the entry's order, the value checks first, with each failing check's actions once", () => {
    const values = { ...presetSettings(), "permissions.parkedPrompt.ttl": "forever" } as unknown as ReturnType<typeof presetSettings>;
    const result = checkStep(
      stepOf("permissions"),
      values,
      { ...holding, "permissions.denylist": () => ({ reason: "The paths section is short." }), "permissions.not-root": () => ({ reason: "Root." }) },
      AT,
    );
    expect(result).toEqual({
      step: "permissions",
      state: "needs-attention",
      reason: "permissions.parkedPrompt.ttl does not hold a valid value. The paths section is short. Root.",
      failing: ["permissions.parkedPrompt.ttl", "permissions.denylist", "permissions.not-root"],
      actions: ["restore"],
      checkedAt: AT,
    });
  });

  it("needs attention when a state check throws, saying it could not check", () => {
    const result = checkStep(
      stepOf("your-machines"),
      presetSettings(),
      {
        ...holding,
        "your-machines.not-root": () => {
          throw new Error("the log is closed");
        },
      },
      AT,
    );
    expect(result).toMatchObject({ state: "needs-attention", reason: "Could not check your-machines.not-root: the log is closed.", failing: ["your-machines.not-root"] });
  });
});
