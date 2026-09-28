import type { AccountUsage, UsageWindow } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import {
  BASELINE_RESERVATION,
  DEFAULT_HANDOFF_THRESHOLDS,
  ULTRACODE_MULTIPLIER,
  USAGE_MAX_AGE_MS,
  bindingWindow,
  currentWindow,
  effortLoadFactor,
  handoffThresholdsWith,
  handoffTrigger,
  isFresh,
  modelLoadFactor,
  planHeadroom,
  rankAccounts,
  recommendAccount,
  reservationFor,
  runLoadFactor,
  windowFor,
  type AccountPlanUsage,
  type HandoffThreshold,
  type PlanWeight,
} from "./handoff.js";

/**
 * The hand-off policy: when an account is near enough its limit that the
 * work should be handed on, what the runs already on an account will spend,
 * and which account has the most room. Pure functions over readings built
 * from literals; whether a reading is fresh is the pool's question, asked
 * here only through `now`. Utilisation is a fraction here, as a reading
 * carries it.
 */

const NOW = Date.parse("2026-09-24T01:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const w = (window: string, utilisation: number | null, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  window,
  utilisation,
  resetsAt: null,
  verdict: null,
  observedAt: iso(NOW),
  ...extra,
});

const reading = (windows: readonly UsageWindow[], extra: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId: "a",
  identity: null,
  windows: [...windows],
  readAt: iso(NOW),
  unavailableReason: null,
  ...extra,
});

/** An API-key login's reading: metered, not capped, so no windows. */
const metered = reading([], { unavailableReason: "No plan limits were reported for this account." });

const rejected = (window: string, utilisation: number | null): UsageWindow => w(window, utilisation, { verdict: "rejected" });

describe("handoffTrigger", () => {
  it("says nothing while every window is under its own threshold", () => {
    expect(handoffTrigger(reading([w("five_hour", 0.89), w("seven_day", 0.97)]))).toBeNull();
  });

  it("fires on the 5-hour window at 90%, the boundary included", () => {
    const trigger = handoffTrigger(reading([w("five_hour", 0.9)]));
    expect(trigger?.threshold.id).toBe("five_hour");
    expect(trigger?.utilisation).toBe(0.9);
  });

  it("holds the weekly window to a much tighter margin than the 5-hour one", () => {
    expect(handoffTrigger(reading([w("seven_day", 0.94)]))).toBeNull();
    expect(handoffTrigger(reading([w("five_hour", 0.94)]))?.threshold.id).toBe("five_hour");
    expect(handoffTrigger(reading([w("seven_day", 0.98)]))?.threshold.id).toBe("seven_day");
  });

  it("finds Fable in a per-model bucket, matching the family rather than one spelling", () => {
    expect(handoffTrigger(reading([w("model_scoped:Fable", 0.96)]))?.threshold.id).toBe("fable");
    expect(handoffTrigger(reading([w("model_scoped:fable-weekly", 0.96)]))?.threshold.id).toBe("fable");
  });

  it("does not read another model's bucket, or a window that is not per-model, as Fable's", () => {
    expect(handoffTrigger(reading([w("model_scoped:Opus", 0.99)]))).toBeNull();
    expect(handoffTrigger(reading([w("fable_somewhere", 0.99)]))).toBeNull();
  });

  it("takes the fullest bucket within the model family", () => {
    const found = windowFor(reading([w("model_scoped:Fable", 0.4), w("model_scoped:Fable-hi", 0.96)]), DEFAULT_HANDOFF_THRESHOLDS[2] as HandoffThreshold);
    expect(found?.utilisation).toBe(0.96);
  });

  it("treats an unreported reading as unknown rather than as full or empty", () => {
    expect(handoffTrigger(reading([w("five_hour", null)]))).toBeNull();
    expect(handoffTrigger(reading([w("five_hour", null), w("seven_day", 0.99)]))?.threshold.id).toBe("seven_day");
  });

  it("says nothing at all for an account with no plan limits, or no reading", () => {
    expect(handoffTrigger(metered)).toBeNull();
    expect(handoffTrigger(null)).toBeNull();
    expect(handoffTrigger(undefined)).toBeNull();
  });

  it("reports in threshold order when more than one rule is met", () => {
    expect(handoffTrigger(reading([w("seven_day", 0.99), w("five_hour", 0.99)]))?.threshold.id).toBe("five_hour");
  });

  it("honours the thresholds it is given instead of the defaults", () => {
    const strict: readonly HandoffThreshold[] = [{ id: "five_hour", label: "5-hour", at: 0.5, match: { kind: "window", window: "five_hour" } }];
    expect(handoffTrigger(reading([w("five_hour", 0.6)]), strict)?.utilisation).toBe(0.6);
    expect(handoffTrigger(reading([w("five_hour", 0.6)]))).toBeNull();
  });

  it("rounds the utilisation it reports to a whole percent, because it goes into a sentence", () => {
    expect(handoffTrigger(reading([w("five_hour", 0.904)]))?.utilisation).toBe(0.9);
    expect(handoffTrigger(reading([w("five_hour", 0.906)]))?.utilisation).toBe(0.91);
  });

  it("does not fire on a window that has rolled over since it was read, when told the time", () => {
    const lapsed = reading([w("five_hour", 0.97, { resetsAt: iso(NOW + 1_000) })]);
    expect(handoffTrigger(lapsed, DEFAULT_HANDOFF_THRESHOLDS, NOW)?.threshold.id).toBe("five_hour");
    expect(handoffTrigger(lapsed, DEFAULT_HANDOFF_THRESHOLDS, NOW + 2_000)).toBeNull();
  });
});

describe("the provider's live verdict", () => {
  it("fires below the threshold when the provider is already refusing", () => {
    const trigger = handoffTrigger(reading([rejected("seven_day", 0.97)]));
    expect(trigger?.threshold.id).toBe("seven_day");
    expect(trigger?.utilisation).toBe(0.97);
  });

  it("describes a refused window with no number as full", () => {
    expect(handoffTrigger(reading([rejected("five_hour", null)]))?.utilisation).toBe(1);
  });

  it("fires on a refused model bucket with no number, and on a refused bucket before a fuller one that is not refused", () => {
    const noNumber = handoffTrigger(reading([rejected("model_scoped:Fable", null)]));
    expect(noNumber?.threshold.id).toBe("fable");
    expect(noNumber?.utilisation).toBe(1);
    const refusedFirst = handoffTrigger(reading([w("model_scoped:Fable", 0.99), rejected("model_scoped:fable-weekly", 0.6)]));
    expect(refusedFirst?.window.window).toBe("model_scoped:fable-weekly");
    expect(refusedFirst?.utilisation).toBe(0.6);
  });

  it("does not fire early on a warning: the thresholds still govern below a refusal", () => {
    expect(handoffTrigger(reading([w("five_hour", 0.8, { verdict: "warning" })]))).toBeNull();
  });
});

describe("handoffThresholdsWith", () => {
  const at = (rules: readonly HandoffThreshold[], id: string): number | undefined => rules.find((rule) => rule.id === id)?.at;

  it("moves only the rule that was moved", () => {
    const rules = handoffThresholdsWith({ five_hour: 0.7 });
    expect(at(rules, "five_hour")).toBe(0.7);
    expect(at(rules, "seven_day")).toBe(0.98);
    expect(at(rules, "fable")).toBe(0.95);
  });

  it("changes what fires, end to end", () => {
    const usage = reading([w("five_hour", 0.75)]);
    expect(handoffTrigger(usage)).toBeNull();
    expect(handoffTrigger(usage, handoffThresholdsWith({ five_hour: 0.7 }))?.threshold.id).toBe("five_hour");
  });

  it("returns the defaults themselves when there are no overrides", () => {
    expect(handoffThresholdsWith(undefined)).toBe(DEFAULT_HANDOFF_THRESHOLDS);
  });

  it("ignores a key that names no rule rather than inventing one", () => {
    expect(handoffThresholdsWith({ retired_rule: 0.1 })).toEqual(DEFAULT_HANDOFF_THRESHOLDS);
  });

  it("clamps into 1% to 100% and rounds to a whole percent", () => {
    expect(at(handoffThresholdsWith({ five_hour: 4 }), "five_hour")).toBe(1);
    expect(at(handoffThresholdsWith({ five_hour: -0.03 }), "five_hour")).toBe(0.01);
    expect(at(handoffThresholdsWith({ five_hour: 0.926 }), "five_hour")).toBe(0.93);
  });

  it("lets a malformed value mean the default", () => {
    expect(at(handoffThresholdsWith({ five_hour: Number.NaN }), "five_hour")).toBe(0.9);
    expect(at(handoffThresholdsWith({ five_hour: "0.85" as unknown as number }), "five_hour")).toBe(0.9);
  });
});

describe("modelLoadFactor", () => {
  it("orders the families small to large", () => {
    expect(modelLoadFactor("haiku")).toBeLessThan(modelLoadFactor("sonnet"));
    expect(modelLoadFactor("sonnet")).toBeLessThan(modelLoadFactor("opus"));
    expect(modelLoadFactor("opus")).toBeLessThan(modelLoadFactor("fable"));
  });

  it("reads a family out of whatever spelling the catalogue used", () => {
    const expected = modelLoadFactor("fable");
    for (const id of ["fable", "claude-fable-5", "claude-fable-5[1m]", "CLAUDE-FABLE-5"]) expect(modelLoadFactor(id)).toBe(expected);
  });

  it("assumes a middling model for one it has never heard of", () => {
    for (const id of ["gpt-5.4", "", null, undefined]) expect(modelLoadFactor(id)).toBe(modelLoadFactor("sonnet"));
    expect(modelLoadFactor("gpt-5.4")).toBeLessThan(modelLoadFactor("fable"));
  });
});

describe("effortLoadFactor", () => {
  it("climbs the ladder", () => {
    const ladder = ["low", "medium", "high", "xhigh", "max"].map(effortLoadFactor);
    for (let i = 1; i < ladder.length; i += 1) expect(ladder[i]).toBeGreaterThan(ladder[i - 1] as number);
  });

  it("falls back to medium, where the providers default", () => {
    for (const effort of ["enthusiastic", null, undefined, ""]) expect(effortLoadFactor(effort)).toBe(effortLoadFactor("medium"));
  });
});

describe("runLoadFactor", () => {
  it("weighs a Fable ultracode run above an Opus max one", () => {
    expect(runLoadFactor({ model: "fable", effort: "xhigh", ultracode: true })).toBeGreaterThan(runLoadFactor({ model: "opus", effort: "max" }));
  });

  it("compounds model and effort", () => {
    expect(runLoadFactor({ model: "opus", effort: "max" })).toBe(modelLoadFactor("opus") * effortLoadFactor("max"));
  });

  it("applies ultracode on top of whatever effort was set, and an absent flag is off", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const plain = runLoadFactor({ model: "sonnet", effort });
      expect(runLoadFactor({ model: "sonnet", effort, ultracode: true })).toBe(plain * ULTRACODE_MULTIPLIER);
      expect(runLoadFactor({ model: "sonnet", effort, ultracode: false })).toBe(plain);
    }
  });

  it("answers for a run it knows nothing about: running is not free", () => {
    expect(runLoadFactor({})).toBeGreaterThan(0);
  });
});

describe("reservationFor", () => {
  it("is nothing for an idle account", () => {
    expect(reservationFor([])).toBe(0);
    expect(reservationFor(undefined)).toBe(0);
  });

  it("adds up, and is denominated in the baseline plan's window", () => {
    const one = reservationFor([{ model: "sonnet", effort: "medium" }]);
    expect(one).toBe(BASELINE_RESERVATION);
    expect(reservationFor([{ model: "sonnet", effort: "medium" }, { model: "sonnet", effort: "medium" }])).toBe(one * 2);
  });

  it("is not clamped, so six heavy sessions outweigh three", () => {
    const heavy = { model: "fable", effort: "xhigh", ultracode: true };
    const three = reservationFor([heavy, heavy, heavy]);
    expect(reservationFor([heavy, heavy, heavy, heavy, heavy, heavy])).toBeCloseTo(three * 2);
  });
});

describe("planHeadroom", () => {
  it("measures the window closest to full, not the average", () => {
    expect(planHeadroom(reading([w("seven_day", 0.05), w("five_hour", 0.98)]), NOW)).toBeCloseTo(0.02);
  });

  it("is null when there is no plan, and 0 when the plan is full", () => {
    expect(planHeadroom(metered, NOW)).toBeNull();
    expect(planHeadroom(reading([w("five_hour", 1)]), NOW)).toBe(0);
    // A provider may report a window beyond its limit: no room, never less than none.
    expect(planHeadroom(reading([w("five_hour", 1.2)]), NOW)).toBe(0);
  });

  it("is null when every window omits its number, or there is no reading", () => {
    expect(planHeadroom(reading([w("five_hour", null)]), NOW)).toBeNull();
    expect(planHeadroom(null, NOW)).toBeNull();
    expect(planHeadroom(undefined, NOW)).toBeNull();
  });
});

/** An entry for `recommendAccount`: an account id and its reading, and whatever else a case gives. */
const entry = (accountId: string, usage: AccountUsage | null | undefined, extra: Omit<Partial<AccountPlanUsage>, "accountId" | "reading"> = {}): AccountPlanUsage => ({
  accountId,
  reading: usage,
  ...extra,
});
const five = (utilisation: number | null, extra: Partial<AccountUsage> = {}): AccountUsage => reading([w("five_hour", utilisation)], extra);

describe("recommendAccount", () => {
  it("names the account with the most room, and the window that decides it", () => {
    const result = recommendAccount([entry("work", five(0.9)), entry("personal", reading([w("five_hour", 0.3), w("seven_day", 0.4)]))], { now: NOW });
    expect(result?.accountId).toBe("personal");
    expect(result?.headroom).toBeCloseTo(0.6);
    expect(result?.binding.window).toBe("seven_day");
    expect(result?.candidates).toBe(2);
  });

  it("never recommends an account that bills per token", () => {
    expect(recommendAccount([entry("plan", five(0.99)), entry("metered", metered)], { now: NOW })).toBeNull();
  });

  it("ignores a reading older than six minutes", () => {
    const stale = five(0.1, { readAt: iso(NOW - USAGE_MAX_AGE_MS - 1), windows: [w("five_hour", 0.1, { observedAt: iso(NOW - USAGE_MAX_AGE_MS - 1) })] });
    const result = recommendAccount([entry("stale", stale), entry("fresh", five(0.8)), entry("other", five(0.85))], { now: NOW });
    expect(result?.accountId).toBe("fresh");
    // Nor counts it: the candidates are the accounts ranked.
    expect(result?.candidates).toBe(2);
  });

  it("counts a reading as fresh from its newest observation: a verdict a run reported since the read", () => {
    const old = iso(NOW - USAGE_MAX_AGE_MS - 60_000);
    const verdictSince = reading([w("five_hour", 0.1, { observedAt: old }), w("seven_day", 0.2, { observedAt: iso(NOW - 1_000), verdict: "warning" })], { readAt: old });
    expect(recommendAccount([entry("folded", verdictSince), entry("fresh", five(0.5))], { now: NOW })?.accountId).toBe("folded");
  });

  it("treats a reading stamped in the future as current, not infinitely stale", () => {
    const ahead = five(0.1, { readAt: iso(NOW + 60_000) });
    expect(recommendAccount([entry("ahead", ahead), entry("here", five(0.5))], { now: NOW })?.accountId).toBe("ahead");
  });

  it("says nothing when only one account can be ranked, unless told one is a choice", () => {
    expect(recommendAccount([entry("only", five(0.2))], { now: NOW })).toBeNull();
    expect(recommendAccount([entry("only", five(0.2))], { now: NOW, minCandidates: 1 })?.accountId).toBe("only");
  });

  it("skips accounts that have never been read, and those whose windows all omit their numbers", () => {
    expect(recommendAccount([entry("known", five(0.2)), entry("unread", null), entry("missing", undefined)], { now: NOW })).toBeNull();
    const result = recommendAccount([entry("blank", five(null)), entry("a", five(0.2)), entry("b", five(0.3))], { now: NOW });
    expect(result?.accountId).toBe("a");
    expect(result?.candidates).toBe(2);
  });

  it("keeps the caller's order on a tie, so the recommendation does not swap between asks", () => {
    const tied = [entry("first", five(0.4)), entry("second", five(0.4))];
    expect(recommendAccount(tied, { now: NOW })?.accountId).toBe("first");
    expect(recommendAccount(tied, { now: NOW })?.accountId).toBe("first");
  });

  it("never names an account with no room, even the least full of full ones, and answers null for no accounts", () => {
    expect(rankAccounts([entry("a", five(1)), entry("b", five(1))], { now: NOW })).toEqual({ candidates: 2, best: null });
    expect(recommendAccount([entry("a", five(1.2)), entry("b", five(1))], { now: NOW })).toBeNull();
    expect(recommendAccount([], { now: NOW })).toBeNull();
  });

  it("ages a reading out at six minutes exactly, the pool's boundary", () => {
    const at = (age: number) => five(0.1, { readAt: iso(NOW - age), windows: [w("five_hour", 0.1, { observedAt: iso(NOW - age) })] });
    expect(recommendAccount([entry("young", at(USAGE_MAX_AGE_MS - 1)), entry("other", five(0.5))], { now: NOW })?.accountId).toBe("young");
    expect(recommendAccount([entry("aged", at(USAGE_MAX_AGE_MS)), entry("other", five(0.5)), entry("third", five(0.6))], { now: NOW })?.accountId).toBe("other");
    expect(isFresh(NOW - USAGE_MAX_AGE_MS + 1, NOW)).toBe(true);
    expect(isFresh(NOW - USAGE_MAX_AGE_MS, NOW)).toBe(false);
    expect(isFresh(NOW + 60_000, NOW)).toBe(true);
  });

  describe("across plans", () => {
    const max: PlanWeight = { id: "claude:max-5x", weight: 5, assumed: true };
    const team: PlanWeight = { id: "claude:team", weight: null, assumed: false };

    it("claims a like-for-like comparison only when one plan is involved", () => {
      const result = recommendAccount([entry("a", five(0.7), { plan: max }), entry("b", five(0.2), { plan: max })], { now: NOW });
      expect(result?.accountId).toBe("b");
      expect(result?.basis).toBe("same-plan");
    });

    it("does not claim one when the accounts are on different plans, or a plan is not known", () => {
      expect(recommendAccount([entry("work", five(0.6), { plan: max }), entry("team", five(0.4), { plan: team })], { now: NOW })?.basis).toBe("percentage");
      const unnamed = recommendAccount([entry("named", five(0.5), { plan: max }), entry("unnamed", five(0.1))], { now: NOW });
      expect(unnamed?.accountId).toBe("unnamed");
      expect(unnamed?.basis).toBe("percentage");
    });

    it("ignores the plan of an account that was never in the running", () => {
      const result = recommendAccount([entry("a", five(0.5), { plan: max }), entry("b", five(0.1), { plan: max }), entry("api-key", metered)], { now: NOW });
      expect(result?.basis).toBe("same-plan");
      expect(result?.candidates).toBe(2);
    });
  });

  describe("weighted by plan size", () => {
    const pro: PlanWeight = { id: "claude:pro", weight: 1, assumed: false };
    const max20: PlanWeight = { id: "claude:max-20x", weight: 20, assumed: false };
    const max5: PlanWeight = { id: "claude:max-5x", weight: 5, assumed: true };

    it("prefers the bigger plan when the smaller one has a larger share free", () => {
      const result = recommendAccount([entry("pro", five(0.1), { provider: "claude", plan: pro }), entry("max", five(0.7), { provider: "claude", plan: max20 })], { now: NOW });
      expect(result?.accountId).toBe("max");
      expect(result?.basis).toBe("weighted");
      expect(result?.plan).toEqual(max20);
    });

    it("still prefers the smaller plan when it genuinely has more capacity", () => {
      const result = recommendAccount([entry("pro", five(0), { provider: "claude", plan: pro }), entry("max", five(0.99), { provider: "claude", plan: max20 })], { now: NOW });
      expect(result?.accountId).toBe("pro");
    });

    it("falls back to percentages when any plan publishes no ratio", () => {
      const team: PlanWeight = { id: "claude:team", weight: null, assumed: false };
      const result = recommendAccount([entry("pro", five(0.1), { provider: "claude", plan: pro }), entry("team", five(0.7), { provider: "claude", plan: team })], { now: NOW });
      expect(result?.basis).toBe("percentage");
      expect(result?.accountId).toBe("pro");
    });

    it("never weighs one provider against another", () => {
      const plus: PlanWeight = { id: "codex:plus", weight: 1, assumed: false };
      const result = recommendAccount([entry("claude", five(0.7), { provider: "claude", plan: max20 }), entry("codex", five(0.1), { provider: "codex", plan: plus })], { now: NOW });
      expect(result?.basis).toBe("percentage");
      expect(result?.accountId).toBe("codex");
    });

    it("reports that an unpinned tier was assumed", () => {
      const result = recommendAccount([entry("a", five(0.7), { provider: "claude", plan: max5 }), entry("b", five(0.8), { provider: "claude", plan: pro })], { now: NOW });
      expect(result?.accountId).toBe("a");
      expect(result?.basis).toBe("weighted");
      expect(result?.assumedPlan).toBe(true);
    });
  });

  describe("with work already running", () => {
    const heavy = { model: "fable", effort: "xhigh", ultracode: true };

    it("sends the next session elsewhere rather than onto the account it just filled", () => {
      expect(recommendAccount([entry("busy", five(0.2), { liveRuns: [heavy] }), entry("idle", five(0.2))], { now: NOW })?.accountId).toBe("idle");
    });

    it("still prefers a busy account that is genuinely much emptier", () => {
      expect(recommendAccount([entry("busy", five(0.05), { liveRuns: [heavy] }), entry("idle", five(0.9))], { now: NOW })?.accountId).toBe("busy");
    });

    it("weighs a heavy run more than a light one, and counts sessions", () => {
      expect(
        recommendAccount([entry("fable", five(0.2), { liveRuns: [heavy] }), entry("haiku", five(0.2), { liveRuns: [{ model: "haiku", effort: "low" }] })], { now: NOW })?.accountId,
      ).toBe("haiku");
      expect(recommendAccount([entry("three", five(0.2), { liveRuns: [heavy, heavy, heavy] }), entry("one", five(0.2), { liveRuns: [heavy] })], { now: NOW })?.accountId).toBe("one");
    });

    it("picks the least over-committed when every account is loaded", () => {
      expect(
        recommendAccount([entry("worse", five(0.8), { liveRuns: [heavy, heavy, heavy, heavy] }), entry("bad", five(0.8), { liveRuns: [heavy, heavy] })], { now: NOW })?.accountId,
      ).toBe("bad");
    });

    it("does not let one run wipe out a large plan", () => {
      const pro: PlanWeight = { id: "claude:pro", weight: 1, assumed: false };
      const max20: PlanWeight = { id: "claude:max-20x", weight: 20, assumed: false };
      const result = recommendAccount(
        [entry("pro", five(0), { provider: "claude", plan: pro, liveRuns: [heavy] }), entry("max20", five(0.8), { provider: "claude", plan: max20, liveRuns: [heavy] })],
        { now: NOW },
      );
      expect(result?.accountId).toBe("max20");
      expect(result?.basis).toBe("weighted");
    });

    it("changes nothing when nothing is running, and reports the real headroom, not the reserved figure", () => {
      const idle = recommendAccount([entry("a", five(0.7)), entry("b", five(0.2))], { now: NOW });
      const empty = recommendAccount([entry("a", five(0.7), { liveRuns: [] }), entry("b", five(0.2), { liveRuns: [] })], { now: NOW });
      expect(empty).toEqual(idle);
      const reserved = recommendAccount([entry("busy", five(0.2), { liveRuns: [heavy] }), entry("idle", five(0.25))], { now: NOW });
      expect(reserved?.accountId).toBe("idle");
      expect(reserved?.headroom).toBeCloseTo(0.75);
    });
  });
});

describe("a refused window", () => {
  it("binds over a fuller allowed one, even with no number, and leaves no room", () => {
    expect(bindingWindow(reading([w("five_hour", 0.98), rejected("seven_day", 0.97)]), NOW)?.window).toBe("seven_day");
    const noNumber = reading([w("five_hour", 0.4), rejected("seven_day", null)]);
    expect(bindingWindow(noNumber, NOW)?.window).toBe("seven_day");
    expect(planHeadroom(noNumber, NOW)).toBe(0);
  });

  it("keeps its account in the ranking, at zero, where it can never win", () => {
    const result = recommendAccount([entry("spent", reading([rejected("seven_day", 0.6)])), entry("ok", reading([w("seven_day", 0.9)]))], { now: NOW });
    expect(result?.accountId).toBe("ok");
    expect(result?.candidates).toBe(2);
  });

  it("is never named, not on a tie at zero that falls to list order, nor when every account is refused", () => {
    const spent = entry("spent", reading([rejected("five_hour", 0.3)]));
    expect(rankAccounts([spent, entry("full", five(1))], { now: NOW })).toEqual({ candidates: 2, best: null });
    expect(rankAccounts([spent, entry("also-spent", reading([rejected("seven_day", null)]))], { now: NOW })).toEqual({ candidates: 2, best: null });
    // Loaded past zero, an account with room still beats a refused one whose score reads higher.
    const heavy = { model: "fable", effort: "max", ultracode: true };
    expect(recommendAccount([spent, entry("busy", five(0.95), { liveRuns: [heavy, heavy] })], { now: NOW })?.accountId).toBe("busy");
  });
});

describe("a window whose reset has passed", () => {
  const RESET = NOW + 10_000;
  const before = iso(NOW + 9_000);
  const stale = reading([w("five_hour", 1, { resetsAt: iso(RESET), observedAt: before }), w("seven_day", 0.4, { observedAt: before })]);

  it("is not what binds the account, and is not its headroom", () => {
    expect(bindingWindow(stale, RESET - 1)?.window).toBe("five_hour");
    expect(bindingWindow(stale, RESET + 1)?.window).toBe("seven_day");
    expect(planHeadroom(stale, RESET - 1)).toBe(0);
    expect(planHeadroom(stale, RESET + 1)).toBeCloseTo(0.6);
  });

  it("is kept when it was observed after the rollover", () => {
    const fresh = w("five_hour", 0.03, { resetsAt: iso(RESET), observedAt: iso(RESET + 500) });
    expect(currentWindow(fresh, RESET + 600)).toBe(fresh);
    expect(bindingWindow(reading([fresh]), RESET + 600)?.utilisation).toBe(0.03);
  });

  it("is nobody the recommendation can rank", () => {
    const spent = reading([w("five_hour", 0.03, { resetsAt: iso(RESET), observedAt: before })]);
    const other = reading([w("five_hour", 0.5, { observedAt: before })]);
    expect(recommendAccount([entry("spent", spent), entry("other", other)], { now: RESET - 1 })?.accountId).toBe("spent");
    expect(recommendAccount([entry("spent", spent), entry("other", other)], { now: RESET + 1 })).toBeNull();
  });

  it("drops a verdict it was carrying", () => {
    const refused = reading([w("five_hour", 0.97, { resetsAt: iso(RESET), observedAt: before, verdict: "rejected" })]);
    expect(planHeadroom(refused, RESET - 1)).toBe(0);
    expect(bindingWindow(refused, RESET + 1)).toBeNull();
    expect(planHeadroom(refused, RESET + 1)).toBeNull();
  });
});
