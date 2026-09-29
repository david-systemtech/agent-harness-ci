import { describe, expect, it } from "vitest";
import { SETUP_ACTIONS, SETUP_TARGET_KINDS, SetupAction, StepResult, StepState } from "./index.js";

/**
 * The result vocabulary of Set up (ADR 0031; the Set up specification,
 * "Actions" and "Skipped"; #568): the named actions with the six verbs the
 * step decisions added, each described for a client in another language,
 * the closed list of what an action applies to, and skipped as derived.
 */

describe("the Set up result vocabulary", () => {
  it("adds start-service, import-again, try-again, write-it-myself, start-over and revise to ADR 0031's eleven actions, and describes each", () => {
    expect(SETUP_ACTIONS).toEqual([
      "sign-in-again",
      "pull-now",
      "check-again",
      "unpair",
      "pair-another",
      "install",
      "update",
      "reload",
      "set-up-this-machine",
      "restore",
      "move",
      "start-service",
      "import-again",
      "try-again",
      "write-it-myself",
      "start-over",
      "revise",
    ]);
    for (const action of SETUP_ACTIONS) expect(SetupAction.description, action).toMatch(new RegExp(`(: |; )${action} \\([^)]+\\)`));
  });

  it("closes the kinds of item an action applies to", () => {
    expect(SETUP_TARGET_KINDS).toEqual(["account", "forge-account", "key-manager-connection", "tool", "skill-source", "chrome", "session", "bank", "denylist-section", "environment"]);
  });

  it("carries each target with the action it serves, and leaves targets out when none was named", () => {
    const result = {
      step: "account",
      state: "needs-attention",
      reason: "Work is signed out.",
      failing: ["account.signed-in"],
      actions: ["sign-in-again"],
      checkedAt: "2026-09-25T08:00:00.000Z",
    };
    expect(StepResult.parse(result)).not.toHaveProperty("targets");
    const targets = [{ action: "sign-in-again", kind: "account", id: "account-work", label: "Work" }];
    expect(StepResult.parse({ ...result, targets }).targets).toEqual(targets);
    expect(StepResult.safeParse({ ...result, targets: [{ kind: "account", id: "account-work", label: "Work" }] }).success).toBe(false);
  });

  it("says skipped is derived from the environment's state and never recorded", () => {
    expect(StepState.description).toContain("derived from the environment's state");
    expect(StepState.description).toContain("never recorded");
  });
});
