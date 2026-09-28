import { describe, expect, it } from "vitest";
import { nextFocus, stepCursor } from "./focus.js";

/**
 * The ring Tab walks and the transcript cursor's step (docs/specs/tui.md,
 * "The screen"): pure, so the focus walk and
 * the cursor step are decisions with no state. The terminal pane is the one
 * stop the harness adds, between the delegated strip and the transcript.
 */

describe("nextFocus", () => {
  const all = { sidebar: true, delegated: true, terminal: true };

  it("walks composer → rail → strip → pane → transcript → composer", () => {
    expect(nextFocus("composer", all)).toBe("sidebar");
    expect(nextFocus("sidebar", all)).toBe("delegated");
    expect(nextFocus("delegated", all)).toBe("terminal");
    expect(nextFocus("terminal", all)).toBe("transcript");
    expect(nextFocus("transcript", all)).toBe("composer");
  });

  it("walks the four stops when no pane is open", () => {
    const stops = { sidebar: true, delegated: true, terminal: false };
    expect(nextFocus("composer", stops)).toBe("sidebar");
    expect(nextFocus("sidebar", stops)).toBe("delegated");
    expect(nextFocus("delegated", stops)).toBe("transcript");
    expect(nextFocus("transcript", stops)).toBe("composer");
  });

  it("steps over a rail the terminal is too narrow to draw", () => {
    const stops = { sidebar: false, delegated: true, terminal: false };
    expect(nextFocus("composer", stops)).toBe("delegated");
    expect(nextFocus("delegated", stops)).toBe("transcript");
  });

  it("steps over a strip with nothing in it", () => {
    const stops = { sidebar: true, delegated: false, terminal: true };
    expect(nextFocus("composer", stops)).toBe("sidebar");
    expect(nextFocus("sidebar", stops)).toBe("terminal");
  });

  it("keeps the transcript on the ring when it is the only other stop", () => {
    const stops = { sidebar: false, delegated: false, terminal: false };
    expect(nextFocus("composer", stops)).toBe("transcript");
    expect(nextFocus("transcript", stops)).toBe("composer");
  });

  it("leads out of a surface that has just gone, to the composer", () => {
    expect(nextFocus("delegated", { sidebar: true, delegated: false, terminal: false })).toBe("composer");
    expect(nextFocus("sidebar", { sidebar: false, delegated: true, terminal: false })).toBe("composer");
    expect(nextFocus("terminal", { sidebar: true, delegated: true, terminal: false })).toBe("composer");
  });

  it("is pure: the same stops give the same step, and the stops are not touched", () => {
    const stops = Object.freeze({ sidebar: true, delegated: false, terminal: true });
    expect(nextFocus("sidebar", stops)).toBe(nextFocus("sidebar", stops));
  });
});

describe("stepCursor", () => {
  const rows = Object.freeze(["a", "b", "c"]);

  it("moves one row at a time", () => {
    expect(stepCursor(rows, "a", 1)).toBe("b");
    expect(stepCursor(rows, "c", -1)).toBe("b");
  });

  it("clamps at both ends rather than wrapping round", () => {
    expect(stepCursor(rows, "a", -1)).toBe("a");
    expect(stepCursor(rows, "c", 1)).toBe("c");
  });

  it("arrives at the end of the transcript, whichever arrow was pressed", () => {
    expect(stepCursor(rows, null, -1)).toBe("c");
    expect(stepCursor(rows, null, 1)).toBe("c");
  });

  it("starts again at the end when the row it was on is no longer drawn", () => {
    expect(stepCursor(rows, "gone", -1)).toBe("c");
  });

  it("has nothing to point at in an empty transcript", () => {
    expect(stepCursor([], null, -1)).toBeNull();
    expect(stepCursor([], "a", 1)).toBeNull();
  });
});
