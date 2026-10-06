import type { UsageGauge } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { markOf, planDelta } from "./plan.js";

/** What a turn cost the plan (docs/specs/tui.md, "The transcript"). */

const gauge = (utilisation: number | null, observedAt: string, window = "five_hour"): UsageGauge => ({
  identity: { provider: "claude", email: "milo@example.com", organisation: null },
  accounts: [{ environmentId: "env", accountId: "account-1" }],
  windows: [{ window, utilisation, resetsAt: null, verdict: null, observedAt }],
  readAt: observedAt,
  unavailableReason: null,
});

describe("planDelta", () => {
  it("uses a human label for an unknown provider limit in the turn's cost", () => {
    expect(planDelta(markOf(gauge(0.1, "2026-09-25T10:00:00.000Z", "iguana_necktie")), markOf(gauge(0.12, "2026-09-25T10:05:00.000Z", "iguana_necktie")))).toEqual(["2.0% of the Other limit window"]);
  });

  it("folds unknown provider limits that moved into one item, by the most any of them moved", () => {
    const at = (utilisations: readonly [number, number, number], observedAt: string): UsageGauge => ({
      ...gauge(utilisations[0], observedAt),
      windows: [["five_hour", utilisations[0]], ["iguana_necktie", utilisations[1]], ["walrus_hat", utilisations[2]]].map(([window, utilisation]) => ({ window: String(window), utilisation: Number(utilisation), resetsAt: null, verdict: null, observedAt })),
    });
    expect(planDelta(markOf(at([0.1, 0.1, 0.2], "2026-09-25T10:00:00.000Z")), markOf(at([0.12, 0.105, 0.21], "2026-09-25T10:05:00.000Z")))).toEqual([
      "2.0% of the 5-hour window",
      "up to 1.0% of other limits",
    ]);
  });

  it("names each window that moved, once a reading observed after the mark has come", () => {
    const before = markOf(gauge(0.1, "2026-09-25T10:00:00.000Z"));
    expect(planDelta(before, markOf(gauge(0.1, "2026-09-25T10:00:00.000Z")))).toBeNull();
    expect(planDelta(before, markOf(gauge(0.132, "2026-09-25T10:05:00.000Z")))).toEqual(["3.2% of the 5-hour window"]);
    expect(planDelta(markOf(gauge(0.5, "2026-09-25T10:00:00.000Z", "seven_day")), markOf(gauge(0.51, "2026-09-25T10:05:00.000Z", "seven_day")))).toEqual(["1.0% of the Weekly window"]);
  });

  it("says nothing of a move under a tenth of a percent, or of a window with no number", () => {
    expect(planDelta(markOf(gauge(0.1, "2026-09-25T10:00:00.000Z")), markOf(gauge(0.1004, "2026-09-25T10:05:00.000Z")))).toEqual([]);
    expect(markOf(gauge(null, "2026-09-25T10:00:00.000Z")).size).toBe(0);
  });
});
