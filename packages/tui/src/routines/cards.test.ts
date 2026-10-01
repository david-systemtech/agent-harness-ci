import { describe, expect, it } from "vitest";
import { firingEntry, preCheckRecord, skipEntry } from "../../test/routines.js";
import { entryLines } from "./cards.js";

/**
 * The history entry drawn under the list (#533): each text cut to its
 * first lines, the line counting the rest naming where it can be read only
 * for a firing's text, which its session keeps whole (PR review).
 */

const SESSION = "0199dd00-0000-4000-8000-00000000a001";
const lines = (count: number, word: string) => Array.from({ length: count }, (_, at) => `${word} ${at + 1}`).join("\n");
const drawn = (entry: Parameters<typeof entryLines>[0]) => entryLines(entry).map((line) => line.map((span) => span.text).join(""));

describe("a history entry's lines", () => {
  it("cuts a firing's text to six lines and says the rest is in its session", () => {
    const shown = drawn(firingEntry("0199dd00-0000-4000-8000-0000000000f1", SESSION, { text: lines(8, "found") }));
    expect(shown).toContain("found 6");
    expect(shown).not.toContain("found 7");
    expect(shown).toContain("… 2 more lines in its session");
  });

  it("cuts a skip's detail and a pre-check's output without pointing at a session, which keeps neither", () => {
    const skip = drawn(skipEntry("0199dd00-0000-4000-8000-0000000000f2", { reason: "pre-check-failed", detail: lines(7, "detail"), preCheck: preCheckRecord(lines(6, "tag")) }));
    expect(skip).toContain("detail 6");
    expect(skip).toContain("… 1 more line");
    expect(skip).toContain("tag 4");
    expect(skip).not.toContain("tag 5");
    expect(skip).toContain("… 2 more lines");
    expect(skip.filter((line) => line.includes("in its session"))).toEqual([]);
  });
});
