import { describe, expect, it } from "vitest";
import { containmentWords, elapsedClock, gaugeOf, pressureOf, readingWords, readingsOf, meterReadingsOf, spendOf, windowLabel, windowOut } from "./words.js";

/** The status line's and the pickers' words, as both renderers say them (docs/specs/tui.md, "Status, usage, pickers"; #147, moved here by #402). */

const gauge = { identity: null, accounts: [], readAt: "2026-09-25T09:00:00.000Z", unavailableReason: null };
const window = (name: string, utilisation: number | null, verdict: "rejected" | null = null) => ({ window: name, utilisation, resetsAt: null, verdict, observedAt: "2026-09-25T09:00:00.000Z" });

describe("a plan window", () => {
  it("keeps unknown limits in details with human names but leaves them out of compact meters", () => {
    const unknown = { ...window("iguana_necktie", 0.37), resetsAt: "2026-09-30T00:00:00.000Z" };
    const pooled = { ...gauge, windows: [window("five_hour", 0.42), unknown] };
    expect(meterReadingsOf(pooled).map((reading) => reading.label)).toEqual(["5-hour"]);
    expect(readingsOf(pooled)[1]).toMatchObject({ label: "Other limit", value: "37%", resetsAt: "2026-09-30T00:00:00.000Z" });
    expect(readingWords(pooled)).toBe("5-hour 42% · Other limit 37%");
  });

  it("folds unknown limits into one item of a one-line summary and leaves out those without a value", () => {
    const unknowns = [window("iguana_necktie", 0.12), window("walrus_hat", null), window("otter_scarf", null)];
    expect(readingWords({ ...gauge, windows: [window("five_hour", 0.42), window("extra_usage", null), ...unknowns] })).toBe("5-hour 42% · Extra usage — · Other limit 12%");
    expect(readingWords({ ...gauge, windows: [window("five_hour", 0.42), ...unknowns.slice(1)] })).toBe("5-hour 42%");
    expect(readingWords({ ...gauge, windows: unknowns.slice(1) })).toBeUndefined();
    expect(readingWords({ ...gauge, windows: [window("five_hour", 0.42), window("iguana_necktie", 0), window("walrus_hat", 0.12), window("otter_scarf", null)] })).toBe(
      "5-hour 42% · Other limits: highest 12%",
    );
    expect(readingWords({ ...gauge, windows: [window("five_hour", 0.42), window("iguana_necktie", 0.6), window("walrus_hat", 0.12, "rejected")] })).toBe(
      "5-hour 42% · Other limits: highest 12% out",
    );
  });

  it("is named as a gauge names it", () => {
    expect(["five_hour", "seven_day", "model_scoped:fable", "extra_usage"].map(windowLabel)).toEqual(["5-hour", "Weekly", "Weekly, Fable", "Extra usage"]);
  });

  it("is pressed by the desktop's thresholds, a refusal out whatever it reads", () => {
    expect(pressureOf({ utilisation: 0.2, verdict: null })).toBe("low");
    expect(pressureOf({ utilisation: 0.75, verdict: null })).toBe("raised");
    expect(pressureOf({ utilisation: 0.9, verdict: null })).toBe("high");
    expect(pressureOf({ utilisation: 0.1, verdict: "rejected" })).toBe("out");
    expect(pressureOf({ utilisation: null, verdict: null })).toBeUndefined();
  });

  it("reads as its label, its percent with out when refused, its pressure, and when it rolls over", () => {
    const fiveHour = { ...window("five_hour", 0.42), resetsAt: "2026-09-25T14:00:00.000Z" };
    expect(readingsOf({ ...gauge, windows: [fiveHour, window("seven_day", 1.02, "rejected"), window("extra_usage", null)] })).toEqual([
      { window: "five_hour", label: "5-hour", utilisation: 0.42, value: "42%", pressure: "low", resetsAt: "2026-09-25T14:00:00.000Z" },
      { window: "seven_day", label: "Weekly", utilisation: 1.02, value: "102% out", pressure: "out", resetsAt: null },
      { window: "extra_usage", label: "Extra usage", utilisation: null, value: "—", pressure: undefined, resetsAt: null },
    ]);
  });

  it("is read from the gauge pooling the session's account on its environment", () => {
    const pooled = { ...gauge, accounts: [{ environmentId: "env", accountId: "account-1" }], windows: [window("five_hour", 0.1)] };
    expect(gaugeOf([pooled], "env", "account-1")).toBe(pooled);
    expect(gaugeOf([pooled], "other", "account-1")).toBeUndefined();
    expect(gaugeOf([pooled], "env", null)).toBeUndefined();
  });

  it("reads a gauge in one line, or its reason when it has no window", () => {
    expect(readingWords({ ...gauge, windows: [window("five_hour", 0.42), window("seven_day", 1.02, "rejected")] })).toBe("5-hour 42% · Weekly 102% out");
    expect(readingWords({ ...gauge, windows: [], unavailableReason: "Not signed in." })).toBe("Not signed in.");
    expect(readingWords(undefined)).toBeUndefined();
  });
});

describe("the run's clock and spend", () => {
  it("holds the clock's width past the first minute", () => {
    expect([elapsedClock(0), elapsedClock(9_900), elapsedClock(64_000), elapsedClock(3_725_000)]).toEqual(["0s", "9s", "1m 04s", "1h 02m"]);
  });

  it("counts every token a run moved, and its dollars only when the provider says", () => {
    const model = { model: "m", inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 5, contextWindow: null };
    expect(spendOf([{ ...model, costUsd: 0.01 }, { ...model, costUsd: 0.02 }])).toEqual({ tokens: 850, costUsd: 0.03 });
    expect(spendOf([{ ...model, costUsd: null }])).toEqual({ tokens: 425, costUsd: null });
    expect(spendOf(null)).toBeUndefined();
  });
});

describe("the containment level", () => {
  it("fills its circle as a run may reach less, and says when it is the environment's default", () => {
    expect(containmentWords("off", false)).toBe("○ off");
    expect(containmentWords("workspace", true)).toBe("◐ workspace (default)");
    expect(containmentWords("workspace-no-network", false)).toBe("● no network");
  });
});

describe("the hand-off offer", () => {
  const recommendation = {
    accountId: null,
    reason: "no-target" as const,
    message: "No other account has room.",
    fromAccountId: "a",
    trigger: null,
    headroom: null,
    binding: null,
    candidates: 0,
    basis: null,
  };
  const trigger = { threshold: "five_hour", label: "5-hour", at: 0.9, window: "five_hour", utilisation: 0.93, verdict: null };

  it("is made when the provider refuses the account's window, with or without an account to take the work", () => {
    expect(windowOut({ ...recommendation, reason: "limit-reached", accountId: "b" })).toBe(true);
    expect(windowOut({ ...recommendation, trigger: { ...trigger, verdict: "rejected" as const } })).toBe(true);
  });

  it("is not made for a window near its limit, one with room, or no answer", () => {
    expect(windowOut({ ...recommendation, reason: "limit-near", accountId: "b", trigger })).toBe(false);
    expect(windowOut({ ...recommendation, reason: "most-room", accountId: "b" })).toBe(false);
    expect(windowOut(null)).toBe(false);
    expect(windowOut(undefined)).toBe(false);
  });
});
