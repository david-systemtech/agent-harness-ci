import { describe, expect, it } from "vitest";
import { followDraft, type DraftSides, type InStep } from "./draft.js";

/** The composer's text kept in step with its session's draft (docs/specs/tui.md and docs/specs/gui.md: the composer). */

const sides = (more: Partial<DraftSides> = {}): DraftSides => ({ session: "one", held: "", text: "", saves: true, ...more });
const inStep = (text: string, session = "one"): InStep => ({ session, text });

describe("a session opened", () => {
  it("waits until the session's draft is known, then takes it into an empty box", () => {
    expect(followDraft(undefined, sides({ held: undefined }))).toEqual({ inStep: undefined });
    expect(followDraft(undefined, sides({ held: "left on the laptop" }))).toEqual({ inStep: inStep("left on the laptop"), take: "left on the laptop" });
    expect(followDraft(inStep("old", "two"), sides({ held: "" }))).toEqual({ inStep: inStep("") });
  });

  it("keeps what was typed before the draft was known, and saves it over the draft next", () => {
    const opened = followDraft(undefined, sides({ held: "left on the laptop", text: "typed first" }));
    expect(opened).toEqual({ inStep: inStep("left on the laptop") });
    expect(followDraft(opened.inStep, sides({ held: "left on the laptop", text: "typed first" }))).toEqual({ inStep: inStep("typed first"), save: "typed first" });
  });
});

describe("another client's draft", () => {
  it("replaces the text while nothing was typed over what this composer held", () => {
    expect(followDraft(inStep("mine"), sides({ held: "theirs", text: "mine" }))).toEqual({ inStep: inStep("theirs"), take: "theirs" });
  });

  it("does not replace text typed over what this composer held, which is saved instead", () => {
    expect(followDraft(inStep("mine"), sides({ held: "theirs", text: "mine, and more" }))).toEqual({ inStep: inStep("mine, and more"), save: "mine, and more" });
  });

  it("does not replace text typed for the renderer itself, which is never saved", () => {
    expect(followDraft(inStep("mine"), sides({ held: "theirs", text: "/attach", saves: false }))).toEqual({ inStep: inStep("mine") });
  });
});

describe("typing", () => {
  it("saves what the box holds once it differs from what was held, an emptied box included", () => {
    expect(followDraft(inStep(""), sides({ text: "half a thought" }))).toEqual({ inStep: inStep("half a thought"), save: "half a thought" });
    expect(followDraft(inStep("sent"), sides({ held: "sent", text: "" }))).toEqual({ inStep: inStep(""), save: "" });
    expect(followDraft(inStep("same"), sides({ held: "same", text: "same" }))).toEqual({ inStep: inStep("same") });
  });
});
