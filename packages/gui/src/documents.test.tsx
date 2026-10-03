import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Documents and Preview panes (docs/specs/gui.md, "The seven panes and
 * the grid"; #410), driven through the harness over the scripted
 * environment's answers and the fake shell's `preview.grant`: the pages,
 * SVGs and markdown a run wrote, listed from `projections.documents`, each
 * opening the preview, its source in the file view, or the transcript at the
 * call that made it; the Preview framing a page or an SVG read through
 * `files.read` at the URL the shell answers, sandboxed with scripts and
 * without same-origin, drawing markdown in the window, reading the file
 * again each time it is opened, and absent without the shell's `preview`.
 */

const PAGE = "<!doctype html><h1>Receipts</h1>";
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const NOTES = "# Notes\n\nThe totals are *summed* once.\n";

/** The local environment with a session opened in the pane, a run live on it. */
const opened = async (more: Partial<ScriptedEnvironment> = {}, shell?: FakeShell) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Site" }], ...more }] }, shell ? { shell } : {});
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  const env = app.environment("desk");
  const session = env.sessionId();
  const { runId } = env.startRun(session, "Make the receipts site");
  return { app, env, session, runId };
};

/** Chooses `name` from the header's side panes menu, from the keyboard: jsdom lays nothing out, so a pointer press lands on the sidebar's divider. */
const openPane = async (app: RenderedApp, name: string) => {
  act(() => within(screen.getByRole("banner")).getByRole("button", { name: "More" }).focus());
  await app.user.keyboard("{Enter}");
  await app.user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) }));
};

/** The pane on screen named `name`. */
const pane = (name: string) => screen.getByRole("region", { name });

/** The Documents pane's row for `path`. */
const row = (path: string) => within(pane("Documents")).getByRole("article", { name: path });

/** The Documents pane's rows, each as its path and what is said of it. */
const rows = () => within(pane("Documents")).queryAllByRole("article").map((article) => article.textContent);

/** The time a run started at `iso` is said with: its hours and minutes where the window is. */
const clock = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** Every grant the shell was asked for: its bytes as text, and its media type. */
const grants = (shell: FakeShell) =>
  shell.calls
    .filter(([member]) => member === "preview.grant")
    .map(([, content]) => {
      const { bytes, mediaType } = content as { readonly bytes: Uint8Array; readonly mediaType: string };
      return { text: new TextDecoder().decode(bytes), mediaType };
    });

/** The name in the side column's strip that reads `name`. */
const named = (name: string) =>
  within(within(screen.getByRole("complementary", { name: "Side column" })).getByRole("tablist", { name: "Open panes" })).getByRole("tab", { name });

/** The Preview pane's frame of `path`; null while none is drawn. */
const frame = (path: string) => screen.queryByTitle(`Preview of ${path}`);

describe("the Documents pane", () => {
  it("lists the pages, SVGs and markdown the session wrote, most recently touched first, as the run writes them", async () => {
    const { app, env, session, runId } = await opened();
    await openPane(app, "Documents");
    expect(within(pane("Documents")).getByText("No pages, SVGs or markdown written yet.")).toBeDefined();

    env.writeFile(session, runId, "site/index.html", PAGE);
    env.writeFile(session, runId, "chart.svg", DRAWING);
    env.writeFile(session, runId, "src/app.ts", "export {};\n");
    env.writeFile(session, runId, "NOTES.md", NOTES);
    env.editFile(session, runId, "site/index.html", "Receipts", "Totals");

    const started = clock(env.events(session).find((event) => event.type === "run.started")?.occurredAt ?? "");
    await waitFor(() =>
      expect(rows()).toEqual([
        `site/index.htmlPage · 32 bytes · 2 revisions · ${started}PreviewSourceTranscript`,
        `NOTES.mdMarkdown · 39 bytes · 1 revision · ${started}PreviewSourceTranscript`,
        `chart.svgSVG · 61 bytes · 1 revision · ${started}PreviewSourceTranscript`,
      ]),
    );
  });

  it("opens on /documents typed at the composer, the command the terminal UI lists the same documents with", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "NOTES.md", NOTES);
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("/documents{Enter}");
    expect(await within(await waitFor(() => pane("Documents"))).findByRole("article", { name: "NOTES.md" })).toBeDefined();
  });

  it("opens a document's source in the Files pane's file view", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "site/index.html", PAGE);
    await openPane(app, "Documents");
    await app.user.click(within(await waitFor(() => row("site/index.html"))).getByRole("button", { name: "Source" }));
    expect(await within(pane("Files")).findByRole("heading", { name: "site/index.html · 32 bytes" })).toBeDefined();
    expect(within(pane("Files")).getByRole("code").textContent).toBe(PAGE);
  });

  it("opens the transcript at the call that first wrote a document: its fold opened, the call focused", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "site/index.html", PAGE);
    env.editFile(session, runId, "site/index.html", "Receipts", "Totals");
    env.endRun(session, runId);
    const transcript = screen.getByRole("region", { name: "Transcript" });
    const fold = await within(transcript).findByRole("button", { name: "Edited 2 files" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");

    await openPane(app, "Documents");
    await app.user.click(within(await waitFor(() => row("site/index.html"))).getByRole("button", { name: "Transcript" }));
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    const written = within(transcript).getByRole("group", { name: "Write: /home/milo/code/site/index.html" });
    expect(document.activeElement).toBe(written);
  });
});

describe("the Preview pane", () => {
  it("frames a page read through files.read at the URL the shell's preview.grant answers, sandboxed with scripts and without same-origin", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "site/index.html", PAGE);
    await openPane(app, "Documents");
    await app.user.click(within(await waitFor(() => row("site/index.html"))).getByRole("button", { name: "Preview" }));

    const framed = await screen.findByTitle("Preview of site/index.html");
    expect(within(pane("Preview")).getByRole("heading", { name: /^site\/index\.html · 32 bytes/ })).toBeDefined();
    expect(framed.getAttribute("src")).toBe("agent-harness-preview://fake/1");
    expect(framed.getAttribute("sandbox")).toBe("allow-scripts");
    expect(grants(app.shell)).toEqual([{ text: PAGE, mediaType: "text/html; charset=utf-8" }]);
    expect(env.requests("files.read").map((request) => request.params)).toEqual([{ sessionId: session, path: "site/index.html" }]);
  });

  it("frames an SVG as one, and draws markdown in the window with nothing granted", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "chart.svg", DRAWING);
    env.writeFile(session, runId, "NOTES.md", NOTES);
    await openPane(app, "Documents");
    await app.user.click(within(await waitFor(() => row("chart.svg"))).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(frame("chart.svg")).not.toBeNull());
    expect(grants(app.shell)).toEqual([{ text: DRAWING, mediaType: "image/svg+xml" }]);

    await app.user.click(named("Documents"));
    await app.user.click(within(row("NOTES.md")).getByRole("button", { name: "Preview" }));
    expect(await within(pane("Preview")).findByRole("heading", { name: "Notes" })).toBeDefined();
    expect(within(pane("Preview")).getByText("summed").tagName).toBe("EM");
    expect(pane("Preview").querySelector("iframe")).toBeNull();
    expect(grants(app.shell)).toHaveLength(1);
  });

  it("is a snapshot: a later write does not change it, and opening the document again reads it again", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "site/index.html", PAGE);
    await openPane(app, "Documents");
    await app.user.click(within(await waitFor(() => row("site/index.html"))).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(frame("site/index.html")?.getAttribute("src")).toBe("agent-harness-preview://fake/1"));

    env.editFile(session, runId, "site/index.html", "Receipts", "Totals");
    await app.user.click(named("Documents"));
    await waitFor(() => expect(within(row("site/index.html")).getByText(/2 revisions/)).toBeDefined());
    await app.user.click(named("Preview"));
    expect(frame("site/index.html")?.getAttribute("src")).toBe("agent-harness-preview://fake/1");
    expect(env.requests("files.read")).toHaveLength(1);

    await app.user.click(named("Documents"));
    await app.user.click(within(row("site/index.html")).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(frame("site/index.html")?.getAttribute("src")).toBe("agent-harness-preview://fake/2"));
    expect(grants(app.shell).map((grant) => grant.text)).toEqual([PAGE, "<!doctype html><h1>Totals</h1>"]);
    expect(env.requests("files.read")).toHaveLength(2);
  });

  it("opens from a document tile in the transcript, on the calls that wrote one", async () => {
    const { app, env, session, runId } = await opened();
    env.writeFile(session, runId, "site/index.html", PAGE);
    env.editFile(session, runId, "site/index.html", "Receipts", "Totals");
    env.writeFile(session, runId, "src/app.ts", "export {};\n");
    const transcript = screen.getByRole("region", { name: "Transcript" });
    const tile = await within(transcript).findByRole("button", { name: "Preview site/index.html" });
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.getAttribute("title")).toContain("Enter or Space");
    // One tile a document, however many of the run's calls wrote it; none for a file that is no document.
    expect(within(transcript).getAllByRole("button", { name: /^Preview / })).toHaveLength(1);

    await app.user.click(tile);
    await waitFor(() => expect(frame("site/index.html")).not.toBeNull());
    expect(grants(app.shell)).toEqual([{ text: "<!doctype html><h1>Totals</h1>", mediaType: "text/html; charset=utf-8" }]);
  });

  it("says why it previews nothing: none chosen, a file it could not read, one past what the environment reads, a binary one", async () => {
    const { app, env, session, runId } = await opened({ fileContents: { "big.html": { text: "<p>", truncated: true, size: 3 * 1024 * 1024 }, "odd.svg": { binary: true, size: 300 } } });
    await openPane(app, "Preview");
    expect(within(pane("Preview")).getByText("Nothing to preview: choose a page, an SVG or a markdown file in Documents.")).toBeDefined();

    env.emit(session, "tool.started", { runId, toolCallId: "w-gone", name: "Write", input: { file_path: "/home/milo/code/gone.md", content: "gone" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "tool.ended", { runId, toolCallId: "w-gone", status: "ok", output: null, durationMs: 20 });
    for (const [path, said] of [
      ["gone.md", "Not read: No file gone.md in the workspace."],
      ["big.html", "Not previewed: big.html is larger than the 2 MiB the environment reads of a file."],
      ["odd.svg", "A binary file of 300 bytes: not shown as text."],
    ] as const) {
      if (path !== "gone.md") {
        env.emit(session, "tool.started", { runId, toolCallId: `w-${path}`, name: "Write", input: { file_path: `/home/milo/code/${path}`, content: "x" }, title: null, agentId: null, parentToolCallId: null });
        env.emit(session, "tool.ended", { runId, toolCallId: `w-${path}`, status: "ok", output: null, durationMs: 20 });
      }
      await app.user.click(await within(screen.getByRole("region", { name: "Transcript" })).findByRole("button", { name: `Preview ${path}` }));
      expect(await within(pane("Preview")).findByText(said)).toBeDefined();
    }
    expect(grants(app.shell)).toEqual([]);
  });

  it("is absent without the shell's preview, with no-shell's line in More, and the Documents pane's Preview and the tile are dim with it", async () => {
    const shell = Object.assign(fakeShell(), { preview: undefined });
    const { app, env, session, runId } = await opened({}, shell);
    env.writeFile(session, runId, "site/index.html", PAGE);
    const line = "This client cannot show a preview: its shell has no shell.preview.";

    await openPane(app, "Preview");
    const unavailable = screen.getByRole("menuitem", { name: "Preview" });
    expect(unavailable.textContent).toContain(line);
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    await app.user.keyboard("{Escape}");

    await openPane(app, "Documents");
    const preview = within(await waitFor(() => row("site/index.html"))).getByRole("button", { name: "Preview" });
    expect(preview.getAttribute("aria-disabled")).toBe("true");
    await app.user.click(preview);
    expect(await screen.findByText(`Not previewed: ${line}`)).toBeDefined();

    const tile = within(screen.getByRole("region", { name: "Transcript" })).getByRole("button", { name: "Preview site/index.html" });
    expect(tile.getAttribute("aria-disabled")).toBe("true");
    expect(frame("site/index.html")).toBeNull();
  });
});
