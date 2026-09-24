import { describe, expect, it } from "vitest";
import { PURGED_STATE, type Decision, type SessionState } from "./decider.js";
import { GENERATED_TITLE_LENGTH, decidePromptTitle, decideProviderTitle, generatedTitle } from "./titles.js";

/**
 * The title fallback's rules on their own (session-state spec, "Title
 * fallback"): the generated title from a user message, set once, and a
 * provider's title, which a user title keeps out. Pure, so each rule is a
 * plain call; `activity.test.ts` drives them through the wire.
 */

const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** A session that is not deleted, with the fields given. */
const live = (fields: Partial<SessionState> = {}): SessionState => ({ ...PURGED_STATE, deleted: false, purged: false, ...fields });

/** The events a decision appends; throws on a refusal. */
const eventsOf = (decision: Decision) => {
  if (decision.rejected !== undefined) throw new Error(`Refused: ${decision.rejected.message}`);
  return decision.events;
};

describe("the generated title of a message", () => {
  it("is its first non-empty line, white space collapsed and trimmed", () => {
    expect(generatedTitle("Fix the receipts")).toBe("Fix the receipts");
    expect(generatedTitle("\n  \n\t Fix   the\treceipts   sweep  \nand then the rest")).toBe("Fix the receipts sweep");
    expect(generatedTitle("\r\n\r\nFirst line\r\nSecond line")).toBe("First line");
    expect(generatedTitle("Only\rcarriage returns")).toBe("Only");
  });

  it("is cut to 80 characters, never inside a character, with no white space left at the cut", () => {
    expect(GENERATED_TITLE_LENGTH).toBe(80);
    const long = "word ".repeat(40);
    const cut = generatedTitle(long);
    expect(cut).toBe(long.slice(0, 80).trimEnd());
    expect(generatedTitle("x".repeat(100))).toBe("x".repeat(80));
    // Eighty characters, each two UTF-16 code units: none of them is split.
    const faces = "\u{1F600}".repeat(100);
    expect(generatedTitle(faces)).toBe("\u{1F600}".repeat(80));
    expect(generatedTitle(`${"y".repeat(79)} z`)).toBe("y".repeat(79));
  });

  it("is none for a message with no non-empty line", () => {
    for (const text of ["", "   ", "\n\n", " \t \r\n "]) expect(generatedTitle(text), JSON.stringify(text)).toBeNull();
  });
});

describe("deciding the title a user message generates", () => {
  it("generates one, source prompt, while the session has no generated title", () => {
    expect(decidePromptTitle(live(), "  Fix the receipts\nthen the sweep")).toEqual([
      { type: "session.title-generated", payload: { title: "Fix the receipts", source: "prompt" } },
    ]);
  });

  it("generates one under a user title too, as the fallback a rename to null reverts to", () => {
    expect(decidePromptTitle(live({ userTitle: "Mine" }), "Fix the receipts")).toEqual([
      { type: "session.title-generated", payload: { title: "Fix the receipts", source: "prompt" } },
    ]);
  });

  it("generates nothing once the session has a generated title, whatever its source: it is set once", () => {
    expect(decidePromptTitle(live({ generatedTitle: "Fix the receipts" }), "Something else")).toEqual([]);
  });

  it("generates nothing from a message with no non-empty line, nor for a session deleted or not there", () => {
    expect(decidePromptTitle(live(), " \n ")).toEqual([]);
    expect(decidePromptTitle({ ...live(), deleted: true }, "Fix it")).toEqual([]);
    expect(decidePromptTitle(null, "Fix it")).toEqual([]);
  });
});

describe("deciding a provider's title", () => {
  it("records it as the generated title, source provider, normalised as a message's is", () => {
    expect(eventsOf(decideProviderTitle(live({ generatedTitle: "Fix the receipts" }), { sessionId: id, title: " Receipts   retention\nsweep " }))).toEqual([
      { type: "session.title-generated", payload: { title: "Receipts retention", source: "provider" } },
    ]);
  });

  it("records nothing while the user has set a title: a user title always wins", () => {
    expect(eventsOf(decideProviderTitle(live({ userTitle: "Mine" }), { sessionId: id, title: "Receipts retention" }))).toEqual([]);
  });

  it("records nothing when it is the generated title already, or empty", () => {
    expect(eventsOf(decideProviderTitle(live({ generatedTitle: "Receipts retention" }), { sessionId: id, title: "Receipts  retention" }))).toEqual([]);
    expect(eventsOf(decideProviderTitle(live(), { sessionId: id, title: "  " }))).toEqual([]);
  });

  it("refuses a session deleted or not there not_found", () => {
    expect(decideProviderTitle(null, { sessionId: id, title: "x" }).rejected).toMatchObject({ code: "not_found" });
    expect(decideProviderTitle({ ...live(), deleted: true }, { sessionId: id, title: "x" }).rejected).toMatchObject({ code: "not_found" });
  });
});
