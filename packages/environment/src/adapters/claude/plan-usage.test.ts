import { describe, expect, it } from "vitest";
import { manualClock } from "../../../test/clock.js";
import type { AccountRef } from "../../adapter/contract.js";
import {
  PLAN_USAGE_MAX_AGE_MS,
  USAGE_METHOD_NAMES,
  createPlanUsageReader,
  mapUsageResponse,
  readUsageMethod,
  type UsageProbe,
} from "./plan-usage.js";

/**
 * The plan-usage read (claude-adapter spec, "Plan usage"): a control-channel
 * read on an unsampled query, found by a tolerant name lookup that degrades
 * to unavailable on a rename; in-flight reads shared; readings aged out
 * after six minutes on the environment's clock; `plan.limit` verdicts folded
 * in; the account's identity on every reading.
 */

const identity = { provider: "claude", email: "david@example.com", organisation: "David's Organization" };
const account: AccountRef = { id: "work", directory: "/data/accounts/work" };

/** The `/usage` control answer, in the pinned SDK's declared shape: percentages 0 to 100. */
const RESPONSE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: "2026-09-24T05:00:00.000Z" },
    seven_day: { utilization: 10.5, resets_at: "2026-09-30T00:00:00Z" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 80, resets_at: "2026-09-30T00:00:00.000Z" }, { utilization: 1, resets_at: null }],
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 5, utilization: 5 },
  },
  behaviors: null,
};

describe("the usage method lookup", () => {
  it("tries usage, then getUsage, then the experimental name: the pinned 0.3.281 declares only the experimental one", () => {
    expect([...USAGE_METHOD_NAMES]).toEqual(["usage", "getUsage", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]);
  });

  it.each(USAGE_METHOD_NAMES)("reads through %s, skipping the transcript scan a meter does not need", async (name) => {
    const calls: unknown[] = [];
    const query = { [name]: async (options: unknown) => (calls.push(options), RESPONSE) };
    expect(await readUsageMethod(query)).toEqual({ kind: "read", response: RESPONSE });
    expect(calls).toEqual([{ skipBehaviors: true }]);
  });

  it("prefers the earlier name when several are there", async () => {
    const used: string[] = [];
    const query = {
      usage: async () => (used.push("usage"), RESPONSE),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => (used.push("experimental"), RESPONSE),
    };
    await readUsageMethod(query);
    expect(used).toEqual(["usage"]);
  });

  it("degrades to missing when the method was renamed away, and to failed when it throws", async () => {
    expect(await readUsageMethod({ somethingElse: async () => RESPONSE })).toEqual({ kind: "missing" });
    expect(await readUsageMethod({ usage: async () => Promise.reject(new Error("control channel closed")) })).toEqual({ kind: "failed", message: "control channel closed" });
  });
});

describe("mapping the answer", () => {
  it("reads each window as a fraction, known windows first, per-model buckets by name, usage credits last", () => {
    const reading = mapUsageResponse(RESPONSE, identity, "2026-09-24T00:00:00.000Z");
    expect(reading).toEqual({
      identity,
      readAt: "2026-09-24T00:00:00.000Z",
      windows: [
        { window: "five_hour", utilisation: 0.42, resetsAt: "2026-09-24T05:00:00.000Z" },
        { window: "seven_day", utilisation: 0.105, resetsAt: "2026-09-30T00:00:00.000Z" },
        { window: "model_scoped:Fable", utilisation: 0.8, resetsAt: "2026-09-30T00:00:00.000Z" },
        { window: "extra_usage", utilisation: 0.05, resetsAt: null },
      ],
    });
  });

  it("passes a window it has never heard of through, rather than hiding a limit", () => {
    const reading = mapUsageResponse({ rate_limits_available: true, rate_limits: { fortnight: { utilization: 3, resets_at: null } } }, identity, "2026-09-24T00:00:00.000Z");
    expect(reading.windows).toEqual([{ window: "fortnight", utilisation: 0.03, resetsAt: null }]);
  });

  it("reports no plan limits as unavailable with a reason, the identity still on it", () => {
    const reading = mapUsageResponse({ rate_limits_available: false, rate_limits: null }, identity, "2026-09-24T00:00:00.000Z");
    expect(reading).toMatchObject({ identity, windows: [], unavailableReason: expect.stringMatching(/No plan limits/) });
  });
});

/** A probe that counts its calls and answers what the test says, when the test says. */
const probing = (answers: (() => Promise<UsageProbe>)[] = []) => {
  let calls = 0;
  const probe = async (): Promise<UsageProbe> => {
    calls += 1;
    const answer = answers.shift();
    return answer === undefined ? { identity, outcome: { kind: "read", response: RESPONSE } } : answer();
  };
  return { probe, calls: () => calls };
};

describe("the reader", () => {
  it("keeps an unknown limit's share and reset and logs its identifier once across accounts and fresh reads", async () => {
    const clock = manualClock();
    const messages: string[] = [];
    const reader = createPlanUsageReader({
      clock,
      diagnostic: (message) => messages.push(message),
      probe: async () => ({ identity, outcome: { kind: "read", response: {
        rate_limits_available: true,
        rate_limits: { iguana_necktie: { utilization: 37, resets_at: "2026-09-30T00:00:00Z" } },
      } } }),
    });
    expect((await reader.read(account)).windows).toEqual([
      { window: "iguana_necktie", utilisation: 0.37, resetsAt: "2026-09-30T00:00:00.000Z" },
    ]);
    clock.advance(PLAN_USAGE_MAX_AGE_MS);
    await reader.read(account);
    await reader.read({ id: "other", directory: "/data/accounts/other" });
    expect(messages).toEqual(["Claude reported an unknown plan-usage window: iguana_necktie"]);
  });

  it("shares a read in flight: two asks, one query", async () => {
    const clock = manualClock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { probe, calls } = probing([async () => (await held, { identity, outcome: { kind: "read", response: RESPONSE } })]);
    const reader = createPlanUsageReader({ clock, probe });
    const first = reader.read(account);
    const second = reader.read(account);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls()).toBe(1);
    expect(a).toBe(b);
  });

  it("answers from the reading for six minutes, and reads again once it has aged out", async () => {
    const clock = manualClock();
    const { probe, calls } = probing();
    const reader = createPlanUsageReader({ clock, probe });
    const first = await reader.read(account);
    expect(first.readAt).toBe("2026-09-24T00:00:00.000Z");
    clock.advance(PLAN_USAGE_MAX_AGE_MS - 1);
    expect(await reader.read(account)).toBe(first);
    expect(calls()).toBe(1);
    clock.advance(1);
    const second = await reader.read(account);
    expect(calls()).toBe(2);
    expect(second.readAt).toBe("2026-09-24T00:06:00.000Z");
  });

  it("keeps readings per account", async () => {
    const clock = manualClock();
    const { probe, calls } = probing();
    const reader = createPlanUsageReader({ clock, probe });
    await reader.read(account);
    await reader.read({ id: "home", directory: "/data/accounts/home" });
    expect(calls()).toBe(2);
  });

  it("folds a plan.limit verdict into the reading: the window's use, its reset and the verdict", async () => {
    const clock = manualClock();
    const reader = createPlanUsageReader({ clock, probe: probing().probe });
    await reader.read(account);
    reader.fold(account, { window: "five_hour", status: "rejected", utilisation: 1, resetsAt: "2026-09-24T06:00:00.000Z" });
    reader.fold(account, { window: "seven_day_overage_included", status: "warning", utilisation: null, resetsAt: null });
    const reading = await reader.read(account);
    expect(reading.windows).toContainEqual({ window: "five_hour", utilisation: 1, resetsAt: "2026-09-24T06:00:00.000Z", verdict: "rejected" });
    expect(reading.windows).toContainEqual({ window: "seven_day_overage_included", utilisation: null, resetsAt: null, verdict: "warning" });
    expect(reading.identity).toEqual(identity);
  });

  it("keeps what a verdict does not say", async () => {
    const clock = manualClock();
    const reader = createPlanUsageReader({ clock, probe: probing().probe });
    await reader.read(account);
    reader.fold(account, { window: "seven_day", status: "warning", utilisation: null, resetsAt: null });
    expect((await reader.read(account)).windows).toContainEqual({ window: "seven_day", utilisation: 0.105, resetsAt: "2026-09-30T00:00:00.000Z", verdict: "warning" });
  });

  it("folds a verdict that arrives while a read is in flight into that read's reading, which began before it", async () => {
    const clock = manualClock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reader = createPlanUsageReader({ clock, probe: probing([async () => (await held, { identity, outcome: { kind: "read", response: RESPONSE } })]).probe });
    const reading = reader.read(account);
    reader.fold(account, { window: "five_hour", status: "rejected", utilisation: 1, resetsAt: null });
    release();
    const expected = { window: "five_hour", utilisation: 1, resetsAt: "2026-09-24T05:00:00.000Z", verdict: "rejected" };
    expect((await reading).windows).toContainEqual(expected);
    expect((await reader.read(account)).windows).toContainEqual(expected);
  });

  it("does not fold a verdict heard during a read into it when the provider answered the read after the verdict: the read is newer (#136)", async () => {
    const clock = manualClock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reader = createPlanUsageReader({ clock, probe: probing([async () => (await held, { identity, outcome: { kind: "read", response: RESPONSE } })]).probe });
    const reading = reader.read(account);
    reader.fold(account, { window: "five_hour", status: "rejected", utilisation: 1, resetsAt: null });
    clock.advance(1_000);
    release();
    expect((await reading).windows[0]).toEqual({ window: "five_hour", utilisation: 0.42, resetsAt: "2026-09-24T05:00:00.000Z" });
  });

  it("lets a read that begins after a verdict replace it, the reading it was folded into having aged out: the read is newer", async () => {
    const clock = manualClock();
    const reader = createPlanUsageReader({ clock, probe: probing().probe });
    await reader.read(account);
    clock.advance(PLAN_USAGE_MAX_AGE_MS);
    reader.fold(account, { window: "five_hour", status: "rejected", utilisation: 1, resetsAt: null });
    expect((await reader.read(account)).windows[0]).toEqual({ window: "five_hour", utilisation: 0.42, resetsAt: "2026-09-24T05:00:00.000Z" });
  });

  it("drops a verdict with no reading to fold into: the next read is newer", async () => {
    const clock = manualClock();
    const reader = createPlanUsageReader({ clock, probe: probing().probe });
    reader.fold(account, { window: "five_hour", status: "rejected", utilisation: 1, resetsAt: null });
    expect((await reader.read(account)).windows[0]).toEqual({ window: "five_hour", utilisation: 0.42, resetsAt: "2026-09-24T05:00:00.000Z" });
  });

  it("degrades a renamed method to unavailable, with the identity", async () => {
    const clock = manualClock();
    const reader = createPlanUsageReader({ clock, probe: probing([async () => ({ identity, outcome: { kind: "missing" } })]).probe });
    expect(await reader.read(account)).toMatchObject({ identity, windows: [], unavailableReason: expect.stringMatching(/does not report plan usage/) });
  });

  it("degrades a failed read to unavailable, and reads again next time rather than keeping the failure", async () => {
    const clock = manualClock();
    const { probe, calls } = probing([async () => ({ identity, outcome: { kind: "failed", message: "timed out" } })]);
    const reader = createPlanUsageReader({ clock, probe });
    expect(await reader.read(account)).toMatchObject({ windows: [], unavailableReason: "Could not read plan usage: timed out" });
    expect((await reader.read(account)).windows).toHaveLength(4);
    expect(calls()).toBe(2);
  });

  it("rejects when the account cannot be identified, and does not keep the read in flight", async () => {
    const clock = manualClock();
    const { probe, calls } = probing([async () => Promise.reject(new Error("The account could not be identified."))]);
    const reader = createPlanUsageReader({ clock, probe });
    await expect(reader.read(account)).rejects.toThrow(/identified/);
    await expect(reader.read(account)).resolves.toMatchObject({ identity });
    expect(calls()).toBe(2);
  });
});
