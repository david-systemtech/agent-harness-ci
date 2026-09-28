import { describe, expect, it } from "vitest";
import { PARITY_GAPS, type ParityGap } from "./index.js";

/**
 * The parity contract's test (ADR 0004, ADR 0017): every gap the terminal UI
 * names, a surface the GUI draws that the terminal cannot, is filed as a
 * `parity` issue for David to decide, and listed with that issue's number.
 * The check is a plain function over the list, so the failure it exists to
 * catch is shown failing on a list broken on purpose.
 */

/** What is wrong with a list of gaps: a gap without its issue's number, and a name or a number listed twice. */
const problems = (gaps: readonly ParityGap[]): string[] => [
  ...gaps.filter((gap) => gap.issue === null || !Number.isInteger(gap.issue) || gap.issue < 1).map((gap) => `${gap.id} has no parity issue`),
  ...gaps.filter((gap, i) => gaps.findIndex((other) => other.id === gap.id) !== i).map((gap) => `${gap.id} is listed twice`),
  ...gaps.filter((gap, i) => gap.issue !== null && gaps.findIndex((other) => other.issue === gap.issue) !== i).map((gap) => `${gap.id} shares its issue`),
];

describe("the parity gaps", () => {
  it("are the five the terminal UI names: the browser dock, the preview, drag reordering, images beyond the terminal protocols and the pane grid", () => {
    expect(PARITY_GAPS.map((gap) => gap.id)).toEqual(["browser-dock", "preview", "drag-reordering", "images", "pane-grid"]);
  });

  it("each hold the number of the parity issue filed for David's decision", () => {
    expect(problems(PARITY_GAPS)).toEqual([]);
  });

  it("fail a gap listed without its issue, and one listed twice", () => {
    const unfiled: ParityGap = { id: "sound", description: "The GUI plays a sound when a run ends.", issue: null };
    expect(problems([...PARITY_GAPS, unfiled])).toEqual(["sound has no parity issue"]);
    const [first] = PARITY_GAPS;
    if (first === undefined) throw new Error("The list names no gap.");
    expect(problems([...PARITY_GAPS, first])).toEqual(["browser-dock is listed twice", "browser-dock shares its issue"]);
  });
});
