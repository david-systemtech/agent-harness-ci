import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  REGISTERED_STEP_IDS,
  SETUP_ACTIONS,
  SETUP_TARGET_KINDS,
  STEP_ORDER,
  STEP_RESULT_DETAILS_MAX,
  SetupAction,
  StepResult,
  StepState,
  eventTypeEntry,
  registry,
  unregisteredSteps,
} from "./index.js";

/**
 * The result vocabulary of Set up (ADR 0031; the Set up specification,
 * "Actions" and "Skipped"; #568): the named actions with the six verbs the
 * step decisions added, each described for a client in another language,
 * the closed list of what an action applies to, and skipped as derived.
 */

describe("the Set up result vocabulary", () => {
  it("adds start-service, import-again, try-again, write-it-myself, start-over, revise and check-certificate to ADR 0031's eleven actions, and describes each", () => {
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
      "check-certificate",
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

  it("carries each time its reason names as data, the words that say it and the instant, and leaves the times out when it names none (#1742)", () => {
    const result = {
      step: "your-machines",
      state: "needs-attention",
      reason: "The host-side updater last polled more than an hour ago, at 2026-10-06 16:24 UTC.",
      failing: ["your-machines.host-updater"],
      actions: ["check-again"],
      checkedAt: "2026-10-06T18:30:00.000Z",
    };
    expect(StepResult.parse(result)).not.toHaveProperty("times");
    const times = [{ text: "more than an hour ago, at 2026-10-06 16:24 UTC", at: "2026-10-06T16:24:10.496Z" }];
    expect(StepResult.parse({ ...result, times }).times).toEqual(times);
    expect(StepResult.safeParse({ ...result, times: [{ text: "more than an hour ago, at 2026-10-06 16:24 UTC", at: "16:24" }] }).success).toBe(false);
    expect(StepResult.safeParse({ ...result, times: [{ text: "", at: "2026-10-06T16:24:10.496Z" }] }).success).toBe(false);
  });

  it("carries the raw facts behind its line apart from it as details, each one line and at most twenty, and leaves them out when there are none (#1836)", () => {
    const result = {
      step: "forges",
      state: "needs-attention",
      reason: "agent-harness could not finish checking this step. Choose Check again.",
      failing: ["forges.reads"],
      actions: ["check-again"],
      checkedAt: "2026-10-08T08:00:00.000Z",
    };
    expect(StepResult.parse(result)).not.toHaveProperty("details");
    const details = ["forges.reads: connect ECONNREFUSED 127.0.0.1:3000"];
    expect(StepResult.parse({ ...result, details }).details).toEqual(details);
    expect(StepResult.safeParse({ ...result, details: ["forges.reads: one\ntwo"] }).success).toBe(false);
    expect(StepResult.safeParse({ ...result, details: [""] }).success).toBe(false);
    expect(StepResult.safeParse({ ...result, details: Array.from({ length: STEP_RESULT_DETAILS_MAX }, (_, n) => `line ${n}`) }).success).toBe(true);
    expect(StepResult.safeParse({ ...result, details: Array.from({ length: STEP_RESULT_DETAILS_MAX + 1 }, (_, n) => `line ${n}`) }).success).toBe(false);
    expect(STEP_RESULT_DETAILS_MAX).toBe(20);
  });

  it("is read whole, its details passed over, by a reader built before details (#1836)", () => {
    const result = {
      step: "your-machines",
      state: "done",
      reason: "desk is ready. It updates itself.",
      failing: [],
      actions: [],
      checkedAt: "2026-10-08T08:00:00.000Z",
    } as const;
    // The result's shape as it was before details: every field the same, details unknown to it.
    const before = StepResult.in.omit({ details: true });
    expect(before.safeParse({ ...result, details: ["Version 0.4.0", "Updates: on"] })).toEqual({ success: true, data: result });
  });

  it("carries pending scheduled reads through results, snapshots and notices without failure actions", () => {
    const pending = { step: "your-machines", state: "pending", reason: "Waiting for the first release channel read.", failing: [], actions: [], checkedAt: "2026-09-25T08:00:00.000Z" };
    expect(StepResult.parse(pending)).toEqual(pending);
    expect(registry["setup.check"].result.parse({ results: [pending] })).toEqual({ results: [pending] });
    const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false };
    expect(registry["environment.subscribe"].result.parse({ status, setup: [pending] })).toEqual({ status, setup: [pending] });
    expect(EnvironmentNotice.parse({ type: "setup.result-changed", payload: pending })).toEqual({ type: "setup.result-changed", payload: pending });
    expect(StepResult.safeParse({ ...pending, lastGood: { state: "pending", reason: pending.reason, checkedAt: pending.checkedAt } }).success).toBe(false);
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
    expect(snapshot.safeParse({ status, setup: [{ ...result, state: "checking" }] }).success).toBe(false);
  });

  it("is offered under the setup capability flag", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("setup");
  });
});

/**
 * A result of a step this build does not register (#672): each entry that
 * lands grows the registry, so an environment built after one answers for a
 * step an older client's registry lacks. A result names any step of the
 * milestone-1 order, so that client reads the answer, the snapshot and the
 * notice whole; asking about a step stays limited to the registered ones.
 */
describe("a result of a step this build does not register", () => {
  const skippedOf = (step: string) => ({ step, state: "skipped", reason: "Nothing is set up here.", failing: [], actions: [], checkedAt: "2026-09-29T08:00:00.000Z" });
  // An environment that registers every step of the order, the ones this build's registry lacks included.
  const newer = STEP_ORDER.map(skippedOf);

  it("reads in setup.check's answer beside the registered steps' results, as in the snapshot and the notice", () => {
    expect(registry["setup.check"].result.parse({ results: newer })).toEqual({ results: newer });
    const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false } as const;
    expect(registry["environment.subscribe"].result.parse({ status, setup: newer })).toEqual({ status, setup: newer });
    for (const result of newer) expect(EnvironmentNotice.parse({ type: "setup.result-changed", payload: result }).payload).toEqual(result);
  });

  it("names a step of the milestone-1 order, and setup.check asks about a registered step only", () => {
    // One past the order is a later milestone's, which the answer and the snapshot pass over (#693).
    expect(StepResult.safeParse(skippedOf("housekeeping")).success).toBe(false);
    for (const step of unregisteredSteps()) expect(registry["setup.check"].params.safeParse({ step }).success, step).toBe(false);
    for (const step of REGISTERED_STEP_IDS) expect(registry["setup.check"].params.safeParse({ step }).success, step).toBe(true);
  });
});

/**
 * A result a newer environment gives in a vocabulary this build's lacks
 * (#693): a verb added to the named actions, a kind of item added to what
 * an action applies to, a step a later milestone adds. None moves the
 * protocol version, so an older client reads what it can of the answer, the
 * snapshot and the notice, and leaves out only the part it cannot act on.
 */
describe("a result in a newer environment's vocabulary", () => {
  const attention = {
    step: "forges",
    state: "needs-attention",
    reason: "The forge refused the credential of david on git.example.com.",
    failing: ["forges.identity"],
    actions: ["sign-in-again", "check-again"],
    checkedAt: "2026-09-29T08:00:00.000Z",
  } as const;
  const done = { step: "account", state: "done", reason: "All your accounts are signed in.", failing: [], actions: [], checkedAt: "2026-09-29T08:00:00.000Z" } as const;

  it("offers no action this build does not know, nor a target serving one, and setup.check's answer reads whole", () => {
    const rotate = { action: "rotate-token", kind: "forge-account", id: "https://git.example.com", label: "david on git.example.com" };
    const newer = { ...attention, actions: ["rotate-token", "sign-in-again", "check-again"], targets: [rotate] };
    expect(StepResult.parse(newer)).toEqual(attention);
    expect(registry["setup.check"].result.parse({ results: [done, newer] })).toEqual({ results: [done, attention] });
    expect(EnvironmentNotice.parse({ type: "setup.result-changed", payload: newer }).payload).toEqual(attention);
  });

  it("leaves out a target of a kind this build does not know, and an action whose every target it left out, which it could only carry out on the wrong item", () => {
    const forgeAccount = { action: "sign-in-again", kind: "forge-account", id: "https://git.example.com", label: "david on git.example.com" };
    const calendar = { action: "sign-in-again", kind: "calendar-account", id: "calendar-work", label: "Work calendar" };
    // Update naming no tool updates this machine: offered with its one target left out, it would update the wrong thing.
    const extension = { action: "update", kind: "browser-extension", id: "extension-1", label: "The extension" };
    const newer = { ...attention, actions: ["sign-in-again", "update", "check-again"], targets: [calendar, forgeAccount, extension] };
    expect(StepResult.parse(newer)).toEqual({ ...attention, targets: [forgeAccount] });

    const none = StepResult.parse({ ...attention, actions: ["update", "check-again"], targets: [extension] });
    expect(none).toEqual({ ...attention, actions: ["check-again"] });
    expect(none).not.toHaveProperty("targets");
  });

  it("passes over a result of a step past the milestone-1 order in setup.check's answer and the snapshot, reading the rest, and its notice is one this build does not know", () => {
    const later = { ...done, step: "housekeeping", reason: "Nothing to sweep." };
    expect(registry["setup.check"].result.parse({ results: [done, later, attention] })).toEqual({ results: [done, attention] });
    const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false } as const;
    expect(registry["environment.subscribe"].result.parse({ status, setup: [later, done] })).toEqual({ status, setup: [done] });
    expect(EnvironmentNotice.safeParse({ type: "setup.result-changed", payload: later }).success).toBe(false);
    // A step of the order with a result no environment gives is no newer vocabulary: the answer is still refused.
    expect(registry["setup.check"].result.safeParse({ results: [done, { ...attention, state: "checking" }] }).success).toBe(false);
  });
});

/**
 * `setup.mint` (ADR 0019; the Set up specification, "The LLM step and
 * minted sessions"; #584): an `admin` command that mints a session for an
 * LLM step and answers its id.
 */
describe("setup.mint", () => {
  const commandId = "5a0f9a3e-6b1e-4b47-9d4c-0f1f6f2b8d11";

  it("is an admin command taking the step, an optional subject, the variant, and an optional account, model and effort, and answers the session id", () => {
    const mint = registry["setup.mint"];
    expect([mint.scope, mint.kind]).toEqual(["admin", "command"]);
    expect(mint.params.safeParse({ commandId, step: "permissions", variant: "first" }).success).toBe(true);
    const full = { commandId, step: "permissions", subject: "bank-1", variant: "revise", account: "claude-max", model: "opus", effort: "high" };
    expect(mint.params.parse(full)).toEqual(full);
    expect(mint.params.safeParse({ commandId, step: "permissions", variant: "again" }).success).toBe(false);
    expect(mint.params.safeParse({ commandId, step: "skills", variant: "first" }).success).toBe(REGISTERED_STEP_IDS.includes("skills" as never));
    const sessionId = "0b8a3c52-2f5e-4c09-9a6f-1c2d3e4f5a6b";
    expect(mint.result.parse({ sessionId })).toEqual({ sessionId });
  });
});
