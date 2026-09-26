import { describe, expect, it } from "vitest";
import { containmentBadge, elapsedClock, meterBar, meterCells, meterTone, readingWords, spendOf, windowLabel, windowOut } from "./line.js";

/** The status line's words (docs/specs/tui.md, "Status, usage, pickers"; Artemis's `StatusBar.test.ts` carried where the rule is the same). */

describe("the plan meter", () => {
  it("lights the first cell for any use and holds the last back until the window is full", () => {
    expect(meterBar(0, 4)).toBe("░░░░");
    expect(meterBar(0.01, 4)).toBe("█░░░");
    expect(meterBar(0.61, 4)).toBe("██░░");
    expect(meterBar(0.99, 4)).toBe("███░");
    expect(meterBar(1, 4)).toBe("████");
    expect(meterBar(0.5, 0)).toBe("");
  });

  it("draws bars only where the line has room, and colours by pressure, a refusal red whatever it reads", () => {
    expect([meterCells(97), meterCells(98), meterCells(118)]).toEqual([0, 4, 5]);
    expect(meterTone({ utilisation: 0.2, verdict: null })).toBe("green");
    expect(meterTone({ utilisation: 0.75, verdict: null })).toBe("yellow");
    expect(meterTone({ utilisation: 0.9, verdict: null })).toBe("red");
    expect(meterTone({ utilisation: 0.1, verdict: "rejected" })).toBe("red");
    expect(meterTone({ utilisation: null, verdict: null })).toBeUndefined();
  });

  it("names the windows as the meter does", () => {
    expect(["five_hour", "seven_day", "model_scoped:fable", "extra_usage"].map(windowLabel)).toEqual(["5hr", "Week", "Fable", "extra usage"]);
  });

  it("reads a gauge in one line, or its reason when it has no window", () => {
    const gauge = { identity: null, accounts: [], readAt: "2026-09-25T09:00:00.000Z", unavailableReason: null };
    const window = (name: string, utilisation: number, verdict: "rejected" | null = null) => ({ window: name, utilisation, resetsAt: null, verdict, observedAt: "2026-09-25T09:00:00.000Z" });
    expect(readingWords({ ...gauge, windows: [window("five_hour", 0.42), window("seven_day", 1.02, "rejected")] })).toBe("5hr 42% · Week 102% out");
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

describe("the containment glyph", () => {
  it("fills as a run may reach less, off in yellow, and says when it is the environment's default", () => {
    expect(containmentBadge("off", false)).toEqual({ text: "○ off", color: "yellow" });
    expect(containmentBadge("workspace", true)).toEqual({ text: "◐ workspace (default)" });
    expect(containmentBadge("workspace-no-network", false)).toEqual({ text: "● no network" });
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
