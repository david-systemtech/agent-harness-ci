import { inMemoryDocuments } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { PRESENTATION_KEYS } from "../../../eslint-rules/no-client-organisation-state.js";
import { PRESENTATION_DEFAULTS, openPresentation } from "./presentation.js";

/**
 * The GUI's client-local presentation (ADR 0003; glossary: Pane): what is
 * open, laid out, folded or preferred on this client, in one module over the
 * platform's documents. Nothing about a session is kept here.
 */
describe("the presentation", () => {
  it("holds a value once set, and tells its followers", async () => {
    const presentation = await openPresentation(inMemoryDocuments());
    const seen: unknown[] = [];
    presentation.values.subscribe((values) => seen.push(values.sidebarWidth));
    expect(presentation.values.read().sidebarWidth).toBeNull();

    presentation.set("sidebarWidth", 24);
    expect(presentation.values.read().sidebarWidth).toBe(24);
    presentation.set("sidebarWidth", 24);
    expect(seen).toEqual([24]);
  });

  it("keeps what it holds in the documents it was opened on, so a presentation opened on them again holds it", async () => {
    const documents = inMemoryDocuments();
    const first = await openPresentation(documents);
    first.set("sidebarWidth", 31.5);
    await first.close();

    expect((await openPresentation(documents)).values.read().sidebarWidth).toBe(31.5);
    expect((await openPresentation(inMemoryDocuments())).values.read().sidebarWidth).toBeNull();
  });

  it("starts from its defaults when the documents hold what it cannot read, reports that once, and keeps each value it can read", async () => {
    const reported: unknown[] = [];
    const unreadable = inMemoryDocuments();
    await unreadable.set("presentation", "not a document");
    expect((await openPresentation(unreadable, (error) => reported.push(error))).values.read()).toEqual(PRESENTATION_DEFAULTS);
    expect(reported).toHaveLength(1);

    const outOfRange = inMemoryDocuments();
    await outOfRange.set("presentation", { format: 1, sidebarWidth: 140, unknownKey: true });
    expect((await openPresentation(outOfRange, (error) => reported.push(error))).values.read()).toEqual(PRESENTATION_DEFAULTS);
    expect(reported).toHaveLength(2);
  });

  it("holds only keys on the organisation-state lint's presentation list", () => {
    for (const key of Object.keys(PRESENTATION_DEFAULTS)) expect(PRESENTATION_KEYS).toContain(key);
  });
});
