import { inMemoryDocuments } from "@agent-harness/client-runtime/testing";
import { DEFAULT_THEME, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { PRESENTATION_KEYS } from "../../../eslint-rules/no-client-organisation-state.js";
import { PRESENTATION_DEFAULTS, openPresentation } from "./presentation.js";

/** The grid before anything is split. */
const ONE_EMPTY_PANE = { rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", session: null, width: 100 }] }], focused: "pane-1" };

/** A pair of panes over a third across the grid, the right one of the pair focused. */
const TWO_ROWS = {
  rows: [
    {
      id: "row-1",
      height: 60,
      panes: [
        { id: "pane-1", session: { environmentId: "env-1", sessionId: "session-1" }, width: 30 },
        { id: "pane-2", session: null, width: 70 },
      ],
    },
    { id: "row-3", height: 40, panes: [{ id: "pane-4", session: { environmentId: "env-2", sessionId: "session-1" }, width: 100 }] },
  ],
  focused: "pane-2",
};

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

  it("holds the grid's panes and the transcript's display preferences, each read back only when it is one this build can show", async () => {
    const documents = inMemoryDocuments();
    const first = await openPresentation(documents);
    expect(first.values.read()).toMatchObject({ paneLayout: ONE_EMPTY_PANE, textSize: 14, readingWidth: "comfortable", reasoningShown: true, streamingFade: true });
    first.set("paneLayout", TWO_ROWS);
    first.set("textSize", 17);
    first.set("readingWidth", "full");
    first.set("reasoningShown", false);
    first.set("streamingFade", false);
    await first.close();
    expect((await openPresentation(documents)).values.read()).toMatchObject({
      paneLayout: TWO_ROWS,
      textSize: 17,
      readingWidth: "full",
      reasoningShown: false,
      streamingFade: false,
    });

    const reported: unknown[] = [];
    const odd = inMemoryDocuments();
    await odd.set("presentation", { format: 1, paneLayout: { session: { environmentId: "env-1", sessionId: "session-1" } }, textSize: 90, readingWidth: "vast", reasoningShown: "yes", streamingFade: null });
    expect((await openPresentation(odd, (error) => reported.push(error))).values.read()).toEqual(PRESENTATION_DEFAULTS);
    expect(String(reported[0])).toContain("paneLayout, textSize, readingWidth, reasoningShown, streamingFade");
  });

  it("reads the grid back only as rows of one to eight panes, each id once, its shares filling the whole, a session in one pane and the focus on a pane it holds", async () => {
    const read = async (paneLayout: unknown) => {
      const documents = inMemoryDocuments();
      await documents.set("presentation", { format: 1, paneLayout });
      return (await openPresentation(documents)).values.read().paneLayout;
    };
    const pane = (id: string, width: number, sessionId: string | null = null) => ({ id, width, session: sessionId === null ? null : { environmentId: "env-1", sessionId } });

    // Shares that do not fill the whole are scaled to; a session shown twice stays in its first pane; a focus on no pane goes to the first.
    expect(await read({ rows: [{ id: "row-1", height: 30, panes: [pane("pane-1", 1, "session-1"), pane("pane-2", 3, "session-1")] }], focused: "pane-9" })).toEqual({
      rows: [{ id: "row-1", height: 100, panes: [pane("pane-1", 25, "session-1"), pane("pane-2", 75)] }],
      focused: "pane-1",
    });

    const nine = Array.from({ length: 9 }, (_, at) => pane(`pane-${at + 1}`, 10));
    for (const unreadable of [
      { rows: [], focused: "pane-1" },
      { rows: [{ id: "row-1", height: 100, panes: [] }], focused: "pane-1" },
      { rows: [{ id: "row-1", height: 100, panes: nine }], focused: "pane-1" },
      { rows: [{ id: "row-1", height: 100, panes: [pane("pane-1", 50), pane("pane-1", 50)] }], focused: "pane-1" },
      { rows: [{ id: "row-1", height: 100, panes: [pane("pane-1", -5)] }], focused: "pane-1" },
      { rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: { environmentId: 7 } }] }], focused: "pane-1" },
    ]) {
      expect(await read(unreadable)).toEqual(ONE_EMPTY_PANE);
    }
  });

  it("holds whether to run an environment on this machine, preset on, read back only as on or off", async () => {
    const documents = inMemoryDocuments();
    const first = await openPresentation(documents);
    expect(first.values.read().runLocalEnvironment).toBe(true);
    first.set("runLocalEnvironment", false);
    await first.close();
    expect((await openPresentation(documents)).values.read().runLocalEnvironment).toBe(false);

    const odd = inMemoryDocuments();
    await odd.set("presentation", { format: 1, runLocalEnvironment: "no" });
    expect((await openPresentation(odd)).values.read().runLocalEnvironment).toBe(true);
  });

  it("holds each session's side column, read back without the panes this build cannot show", async () => {
    const documents = inMemoryDocuments();
    const first = await openPresentation(documents);
    expect(first.values.read().sideColumns).toEqual({});
    first.set("sideColumns", { "env-1 session-1": { open: ["files", "tasks"], shown: "tasks", hidden: true } });
    await first.close();
    expect((await openPresentation(documents)).values.read().sideColumns).toEqual({ "env-1 session-1": { open: ["files", "tasks"], shown: "tasks", hidden: true } });

    const newer = inMemoryDocuments();
    await newer.set("presentation", {
      format: 1,
      sideColumns: {
        "env-1 session-1": { open: ["hologram", "diff", "diff"], shown: "hologram", hidden: false },
        "env-1 session-2": { open: ["hologram"], shown: "hologram", hidden: false },
        "env-1 session-3": "files",
      },
    });
    expect((await openPresentation(newer)).values.read().sideColumns).toEqual({ "env-1 session-1": { open: ["diff"], shown: "diff", hidden: false } });

    const reported: unknown[] = [];
    const odd = inMemoryDocuments();
    await odd.set("presentation", { format: 1, sideColumns: ["files"] });
    expect((await openPresentation(odd, (error) => reported.push(error))).values.read().sideColumns).toEqual({});
    expect(String(reported[0])).toContain("sideColumns");
  });

  it("holds the light or dark preference, preset to the OS's, and the cached theme, preset none, each read back only when it is one", async () => {
    const olive: Theme = { name: "Olive", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 110, chroma: 0.02 }, accent: { hue: 130, chroma: 0.15 } } };
    const documents = inMemoryDocuments();
    const first = await openPresentation(documents);
    expect(first.values.read()).toMatchObject({ lightOrDark: "system", cachedTheme: null });
    first.set("lightOrDark", "light");
    first.set("cachedTheme", olive);
    await first.close();
    expect((await openPresentation(documents)).values.read()).toMatchObject({ lightOrDark: "light", cachedTheme: olive });

    const reported: unknown[] = [];
    const odd = inMemoryDocuments();
    await odd.set("presentation", { format: 1, lightOrDark: "dim", cachedTheme: { name: "Olive", seeds: { canvas: { hue: 110, chroma: 0.02 } } } });
    expect((await openPresentation(odd, (error) => reported.push(error))).values.read()).toMatchObject({ lightOrDark: "system", cachedTheme: null });
    expect(String(reported[0])).toContain("lightOrDark, cachedTheme");
  });

  it("holds whether the sidebar is shown, preset shown, and the headings folded by name, preset none, each read back only when it is one", async () => {
    const documents = inMemoryDocuments();
    const first = await openPresentation(documents);
    expect(first.values.read()).toMatchObject({ sidebarShown: true, collapsedHeadings: {} });
    first.set("sidebarShown", false);
    first.set("collapsedHeadings", { "group:brandsolidate": true, "shelf:settled": false });
    await first.close();
    expect((await openPresentation(documents)).values.read()).toMatchObject({ sidebarShown: false, collapsedHeadings: { "group:brandsolidate": true, "shelf:settled": false } });

    const reported: unknown[] = [];
    const odd = inMemoryDocuments();
    await odd.set("presentation", { format: 1, sidebarShown: "no", collapsedHeadings: { "block:pinned": "yes" } });
    expect((await openPresentation(odd, (error) => reported.push(error))).values.read()).toMatchObject({ sidebarShown: true, collapsedHeadings: {} });
    expect(String(reported[0])).toContain("sidebarShown, collapsedHeadings");
  });

  it("holds only keys on the organisation-state lint's presentation list", () => {
    for (const key of Object.keys(PRESENTATION_DEFAULTS)) expect(PRESENTATION_KEYS).toContain(key);
  });
});
