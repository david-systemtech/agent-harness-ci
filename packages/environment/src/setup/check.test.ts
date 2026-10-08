import { CHECK_BUDGET_SECONDS, SETTINGS_KEYS, STEP_REGISTRY, presetSettings, registry, type RegisteredStep, type SettingsValues } from "@agent-harness/contracts";
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
      reason: "Set.",
      failing: [],
      actions: [],
      checkedAt: AT,
    });
    expect(await check(stepOf("browser"), presetSettings(), holding)).toMatchObject({ state: "done", reason: "Chrome is connected." });
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
    const found = { reason: "Found earlier work you can bring over: 7 profiles.", details: ["Folder: /srv/source-data"] };
    expect(await check(stepOf("carry-over"), presetSettings(), holding, () => found)).toMatchObject({ state: "done", ...found });
    expect(await check(stepOf("carry-over"), presetSettings(), holding, async () => undefined)).toMatchObject({ state: "done", reason: "Everything is already here." });
    expect(await check(stepOf("carry-over"), presetSettings(), holding, async () => Promise.reject(new Error("EACCES")))).toMatchObject({ state: "done", reason: "Everything is already here." });
    // A step that does not pass never asks for it.
    let asked = false;
    const failing = await check(stepOf("carry-over"), presetSettings(), { ...holding, "carry-over.readable": () => ({ reason: "A directory cannot be read." }) }, () => ((asked = true), found));
    expect([failing.state, asked]).toEqual(["needs-attention", false]);
  });

  it("adds what a passing check says it found after the step's line and leaves failure actions out", async () => {
    const stateChecks: StateCheckers = { ...holding, "permissions.denylist": async () => ({ holds: true, reason: "The denylist was deliberately emptied." }) };
    expect(await check(stepOf("permissions"), presetSettings(), stateChecks)).toMatchObject({
      state: "done",
      reason: "Set. The denylist was deliberately emptied.",
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
      reason: "A saved setting for this step cannot be used: Unanswered permission timeout. Set it again in Settings. The paths section is short. Root.",
      details: ["permissions.parkedPrompt.ttl"],
      failing: ["permissions.parkedPrompt.ttl", "permissions.denylist", "permissions.not-root"],
      actions: ["restore"],
      checkedAt: AT,
    });
  });

  it("carries the times the failing checks' reasons name, in the entry's order, and none when no failure names one (#1742)", async () => {
    const polled = { text: "more than an hour ago, at 2026-09-25 06:00 UTC", at: "2026-09-25T06:00:00.000Z" };
    const result = await check(stepOf("your-machines"), presetSettings(), {
      ...holding,
      "your-machines.not-root": () => ({ reason: "Root." }),
      "your-machines.host-updater": () => ({ reason: `The host-side updater last polled ${polled.text}.`, times: [polled] }),
    });
    expect(result).toMatchObject({ state: "needs-attention", reason: `Root. The host-side updater last polled ${polled.text}.`, times: [polled] });
    const without = await check(stepOf("your-machines"), presetSettings(), { ...holding, "your-machines.not-root": () => ({ reason: "Root." }) });
    expect(without).not.toHaveProperty("times");
  });

  it("needs attention when a state check throws, saying in plain words it could not finish, the check and its error in details, with Check again (#1836)", async () => {
    const result = await check(stepOf("your-machines"), presetSettings(), {
      ...holding,
      "your-machines.not-root": () => {
        throw new Error("the log is closed");
      },
    });
    expect(result).toMatchObject({
      state: "needs-attention",
      reason: "agent-harness could not finish checking this step. Choose Check again.",
      details: ["your-machines.not-root: the log is closed"],
      failing: ["your-machines.not-root"],
      actions: ["check-again"],
    });
  });

  it("says once that it could not finish when several checks throw, beside each other failure's own sentence, every check's error in details (#1836)", async () => {
    const result = await check(stepOf("your-machines"), presetSettings(), {
      ...holding,
      "your-machines.not-root": () => {
        throw new Error("the log is closed.");
      },
      "your-machines.named": () => ({ reason: "This computer has no name. Give it one in More options." }),
      "your-machines.lan": async () => Promise.reject(new Error("no interfaces\nread")),
    });
    expect(result).toMatchObject({
      reason: "agent-harness could not finish checking this step. Choose Check again. This computer has no name. Give it one in More options.",
      details: ["your-machines.not-root: the log is closed", "your-machines.lan: no interfaces read"],
      failing: ["your-machines.not-root", "your-machines.named", "your-machines.lan"],
      actions: ["check-again"],
    });
  });

  it("names a setting it cannot use by its label, the key in details, beside what a failing check puts in details (#1836)", async () => {
    const values = { ...presetSettings(), "permissions.parkedPrompt.ttl": "forever" } as unknown as ReturnType<typeof presetSettings>;
    const result = await check(stepOf("permissions"), values, {
      ...holding,
      "permissions.containment": () => ({ reason: "The sandbox you chose does not work on this computer yet.", details: ["bwrap: setting up uid map: Permission denied"] }),
    });
    expect(result).toMatchObject({
      reason: "A saved setting for this step cannot be used: Unanswered permission timeout. Set it again in Settings. The sandbox you chose does not work on this computer yet.",
      details: ["permissions.parkedPrompt.ttl", "bwrap: setting up uid map: Permission denied"],
    });
  });

  it("keeps the facts the environment found apart from a done step's line, and those a passing check gives (#1836)", async () => {
    const result = await check(stepOf("your-machines"), presetSettings(), { ...holding, "your-machines.lan": () => ({ holds: true, reason: "Devices on this network can reach it.", details: ["Network address: 192.0.2.20"] }) }, () => ({
      reason: "desk is ready. It updates itself.",
      details: ["Version: 0.4.0"],
    }));
    expect(result).toEqual({
      step: "your-machines",
      state: "done",
      reason: "desk is ready. It updates itself. Devices on this network can reach it.",
      details: ["Version: 0.4.0", "Network address: 192.0.2.20"],
      failing: [],
      actions: [],
      checkedAt: AT,
    });
  });

  it("says the describing conversation stopped, once however many did, the provider's words in details (setup-copy.md §5.8; #1836)", async () => {
    const bank = { kind: "bank", id: "bank-1", label: "personal" } as const;
    const stopped = [
      { sessionId: "session-1", title: "Set up: Memory bank (personal)", subject: bank, error: "The provider is overloaded." },
      { sessionId: "session-2", title: "Set up: Memory bank (team)", subject: null, error: null },
    ];
    const result = await checkStep(stepOf("memory-bank"), {
      values: presetSettings(),
      stateChecks: { ...holding, "memory-bank.manifest": () => ({ reason: "personal needs a description." }) },
      clock: manualClock(AT),
      checkedAt: AT,
      askedBy: "client",
      lastGood: undefined,
      llm: { subjects: () => [bank], stopped: () => stopped },
    });
    expect(result).toMatchObject({
      state: "needs-attention",
      reason: "The describing conversation stopped. personal needs a description.",
      details: ["The provider is overloaded."],
      actions: ["try-again", "write-it-myself", "start-over", "revise"],
    });
  });

  it("keeps at most twenty lines of details, each once", async () => {
    const lines = Array.from({ length: 25 }, (_, n) => `forge ${n % 22}`);
    const result = await check(stepOf("forges"), presetSettings(), { ...holding, "forges.reads": () => ({ reason: "Some reads did not pass.", details: lines }) });
    expect(result.details).toEqual(Array.from({ length: 20 }, (_, n) => `forge ${n}`));
  });
});

/**
 * No line of any registered step's result holds a raw fact (setup-copy.md
 * §1.7, §3): whatever its checks throw or answer, a check id, a settings key,
 * an ISO time, an HTTP status or a method name is in details, never in the
 * reason (#1836).
 */
describe("a step's line on every registered step", () => {
  const RAW = "HTTP 503 from forge.accounts.add at 2026-10-08T08:00:00.000Z";
  const methods = Object.keys(registry);
  const checkIds = STEP_REGISTRY.flatMap((step) => step.stateChecks.map((stateCheck) => stateCheck.id));

  const plain = (reason: string, what: string) => {
    expect(reason, what).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(reason, what).not.toMatch(/\bHTTP\b|\b[1-5]\d\d\b/);
    for (const method of methods) expect(reason, `${what}: ${method}`).not.toContain(method);
    for (const id of checkIds) expect(reason, `${what}: ${id}`).not.toContain(id);
    for (const key of SETTINGS_KEYS) expect(reason, `${what}: ${key}`).not.toContain(key);
  };

  it("holds no check id, settings key, ISO time, HTTP status or method name, done, when a check throws, when a value is refused, or when its checks take too long", async () => {
    for (const step of STEP_REGISTRY) {
      plain((await check(step, presetSettings(), holding)).reason, `${step.id} done`);
      for (const { id } of step.stateChecks) {
        const throws: StateCheckers = { ...holding, [id]: () => Promise.reject(new Error(RAW)) };
        const result = await check(step, presetSettings(), throws);
        plain(result.reason, `${id} throws`);
        expect(result.details, id).toEqual([`${id}: ${RAW}`]);
      }
      for (const { key } of step.checks) {
        const values = { ...presetSettings(), [key]: Symbol("unusable") } as unknown as SettingsValues;
        plain((await check(step, values, holding)).reason, `${key} refused`);
      }
      const clock = manualClock(AT);
      const never: StateCheckers = { ...holding, [step.stateChecks[0]?.id ?? ""]: () => new Promise<never>(() => undefined) };
      const pending = checkStep(step, { values: presetSettings(), stateChecks: never, clock, checkedAt: AT, askedBy: "client", lastGood: undefined });
      clock.advance(CHECK_BUDGET_SECONDS[step.budget] * 1000);
      const timedOut = await pending;
      plain(timedOut.reason, `${step.id} timed out`);
    }
  });
});
