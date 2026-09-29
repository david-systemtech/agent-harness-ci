import { describe, expect, it } from "vitest";
import { containmentBadge, meterBar, meterCells, meterTone } from "./line.js";

/** How the status line draws its words in a terminal (docs/specs/tui.md, "Status, usage, pickers"); the words are the client runtime's (`status/words.test.ts`). */

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
});

describe("the containment glyph", () => {
  it("fills as a run may reach less, off in yellow, and says when it is the environment's default", () => {
    expect(containmentBadge("off", false)).toEqual({ text: "○ off", color: "yellow" });
    expect(containmentBadge("workspace", true)).toEqual({ text: "◐ workspace (default)" });
    expect(containmentBadge("workspace-no-network", false)).toEqual({ text: "● no network" });
  });
});
