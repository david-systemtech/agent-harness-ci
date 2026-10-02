import { describe, expect, it } from "vitest";
import { ROUTINE_PRESETS } from "./routines.js";
import { isSilent } from "./silence.js";
import { SILENCE_CASES } from "./silence-cases.js";

/**
 * The silence rule (routines spec, "Silence"; #524), after Hermes's
 * response-filter tests: the routine's marker alone, or on its own first or
 * last line beside a note, or a bracketed marker opening the text, delivers
 * nothing; a marker in prose is delivered.
 */

const marker = ROUTINE_PRESETS.silenceMarker;

describe("the silence rule", () => {
  it("is silent for the marker alone, whatever its case, padding or edge punctuation", () => {
    for (const text of ["[SILENT]", " [SILENT] ", "[silent]", "\n\n[SILENT]\n", "**[SILENT]**", "[SILENT]."]) expect(isSilent(text, marker), text).toBe(true);
  });

  it("is silent for the marker on its own first or last line beside a note, and for a bracketed marker opening the text", () => {
    expect(isSilent("[SILENT]\n\nNothing new this tick.", marker)).toBe(true);
    expect(isSilent("2 deals filtered\n\n[SILENT]", marker)).toBe(true);
    expect(isSilent("[SILENT] No changes detected", marker)).toBe(true);
  });

  it("delivers the marker mid-sentence, and is never silent for empty text", () => {
    expect(isSilent("The lane said [SILENT] mid-sentence and kept talking", marker)).toBe(false);
    expect(isSilent("Checked the feeds.\n[SILENT]\nThree releases since Monday.", marker)).toBe(false);
    expect(isSilent("", marker)).toBe(false);
    expect(isSilent(" \n\t ", marker)).toBe(false);
  });

  it("takes a routine's own marker in place of [SILENT]", () => {
    expect(isSilent("Nothing to report.", "NOTHING TO REPORT")).toBe(true);
    expect(isSilent("[SILENT]", "NOTHING TO REPORT")).toBe(false);
    expect(isSilent("[quiet] the feeds were unchanged", "[QUIET]")).toBe(true);
  });
});

describe.each(SILENCE_CASES.map((entry) => [entry.note, entry] as const))("the published case: %s", (_, entry) => {
  it(entry.silent ? "is silent" : "is delivered", () => {
    expect(isSilent(entry.text, entry.marker)).toBe(entry.silent);
  });
});
