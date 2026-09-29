import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  SETUP_ACTIONS,
  SETUP_TARGET_KINDS,
  SetupAction,
  StepResult,
  StepState,
  eventTypeEntry,
  registry,
} from "./index.js";

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

/**
 * ADR 0031's `setup` subscription (the Set up specification, "Results, the
 * cache and the subscription"; #569): each change of a step's cached result
 * as a notice on the environment stream, every step's cached result in
 * `environment.subscribe`'s snapshot, and the flag that says an environment
 * serves them.
 */
describe("the setup subscription", () => {
  const result = {
    step: "forges",
    state: "needs-attention",
    reason: "The forge refused the credential of david on github.com: Sign in again to give it a new one.",
    failing: ["forges.identity"],
    actions: ["sign-in-again"],
    targets: [{ action: "sign-in-again", kind: "forge-account", id: "https://github.com", label: "david on github.com" }],
    checkedAt: "2026-09-29T08:00:00.000Z",
  } as const;
  const skipped = { step: "account", state: "skipped", reason: "No account is added.", failing: [], actions: [], checkedAt: "2026-09-29T08:00:00.000Z" } as const;

  it("notices a changed result as setup.result-changed, carrying the result, on the environment stream and never in the session list", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("setup.result-changed");
    expect(EnvironmentNotice.parse({ type: "setup.result-changed", payload: result })).toEqual({ type: "setup.result-changed", payload: result });
    expect(EnvironmentNotice.safeParse({ type: "setup.result-changed", payload: { ...result, checkedAt: undefined } }).success).toBe(false);
    expect(EnvironmentNotice.safeParse({ type: "setup.result-changed", payload: { ...result, step: "not-a-step" } }).success).toBe(false);
    expect(eventTypeEntry("environment", "setup.result-changed")).toMatchObject({ list: false });
    expect(eventTypeEntry("session", "setup.result-changed")).toBeUndefined();
  });

  it("gives environment.subscribe's snapshot every checked step's cached result as setup, which an environment without it leaves out", () => {
    const snapshot = registry["environment.subscribe"].result;
    const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false } as const;
    expect(snapshot.parse({ status, setup: [skipped, result] })).toEqual({ status, setup: [skipped, result] });
    expect(snapshot.parse({ status, setup: [] })).toEqual({ status, setup: [] });
    expect(snapshot.parse({ status })).toEqual({ status });
    expect(snapshot.safeParse({ status, setup: [{ ...result, state: "pending" }] }).success).toBe(false);
  });

  it("is offered under the setup capability flag", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("setup");
  });
});
