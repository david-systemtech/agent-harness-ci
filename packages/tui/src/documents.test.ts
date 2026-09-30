import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The session's documents in the terminal UI (docs/specs/tui.md, "The
 * parity contract in practice"; #427), driven through the harness over the
 * scripted environment's runs writing and editing files as Claude's `Write`
 * and `Edit` do (#410): `/documents` lists `projections.documents`, newest
 * first, live; Enter reads a markdown document in the pager through
 * `files.read`, searched and copied as any page is, and a page or an SVG is
 * one line naming the desktop window's preview and its path, never read.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const WORKSPACE = "/home/seth/receipts";

const PAGE = "<!doctype html><h1>Receipts</h1>";
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const NOTES = "# Notes\n\nThe totals are summed once.\n";

/** The session open on the local environment, a run live on it. */
const launch = async (environment: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: {
      environments: [{ name: "desk", reach: "local", sessions: [{ id: SESSION, title: "Receipts", workspace: { kind: "directory", path: WORKSPACE } }], ...environment }],
    },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  const { runId } = env.startRun(SESSION, "Make the receipts site");
  return { app, env, runId };
};

const command = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

/** The time the session's run started, as a list says it the same day: its hours and minutes where the terminal is. */
const started = (app: RenderedApp): string => {
  const iso = app.environment("desk").events(SESSION).find((event) => event.type === "run.started")?.occurredAt ?? "";
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** The Documents card's rows, right of the rail, each without the cursor's mark. */
const listed = (app: RenderedApp): string[] =>
  app
    .rows()
    .map((row) => row.slice(row.lastIndexOf("│") + 1).trim().replace(/^› /, ""))
    .filter((row) => /^\S+\.(html|svg|md) {2}/.test(row));

describe("/documents", () => {
  it("lists the session's documents newest first, with kind, size, revisions and change time, following the projection live, and says so when there are none", async () => {
    const { app, env, runId } = await launch();
    await command(app, "/documents");
    await app.waitFor("No pages, SVGs or markdown written yet.");

    env.writeFile(SESSION, runId, "site/index.html", PAGE);
    env.writeFile(SESSION, runId, "chart.svg", DRAWING);
    env.writeFile(SESSION, runId, "src/app.ts", "export {};\n");
    env.writeFile(SESSION, runId, "NOTES.md", NOTES);
    env.editFile(SESSION, runId, "site/index.html", "Receipts", "Totals");

    const at = started(app);
    await app.waitUntil(() => listed(app).length === 3, "the three documents listed");
    expect(listed(app)).toEqual([
      `site/index.html  Page · 32 bytes · 2 revisions · ${at}`,
      `NOTES.md  Markdown · 37 bytes · 1 revision · ${at}`,
      `chart.svg  SVG · 61 bytes · 1 revision · ${at}`,
    ]);
    expect(app.frame()).not.toContain("No pages, SVGs or markdown written yet.");
  });

  it("reads a markdown document in the pager through files.read on Enter, searched and copied whole as a page is, and goes back to the list", async () => {
    const { app, env, runId } = await launch();
    env.writeFile(SESSION, runId, "NOTES.md", NOTES);
    env.writeFile(SESSION, runId, "site/index.html", PAGE);
    await command(app, "/documents");
    await app.waitUntil(() => listed(app).length === 2, "the two documents listed");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("The totals are summed once.");
    expect(app.frame()).toContain("NOTES.md · 37 bytes");
    expect(env.requests("files.read").map((request) => request.params)).toEqual([{ sessionId: SESSION, path: "NOTES.md" }]);

    await app.press("/");
    await app.type("summed");
    await app.press(KEY.enter);
    await app.waitFor("1 match for summed");

    await app.press("y");
    await app.waitFor("Copied NOTES.md.");
    expect(app.clipboard.copied).toEqual([NOTES]);

    await app.press("q");
    await app.waitFor("Documents");
    expect(listed(app)).toHaveLength(2);
  });

  it("says in one line that a page or an SVG opens in the desktop window's preview, with its path, and reads neither", async () => {
    const { app, env, runId } = await launch();
    env.writeFile(SESSION, runId, "site/index.html", PAGE);
    env.writeFile(SESSION, runId, "chart.svg", DRAWING);
    await command(app, "/documents");
    await app.waitUntil(() => listed(app).length === 2, "the two documents listed");

    await app.press(KEY.enter);
    await app.waitFor("The desktop window's preview draws this SVG, not the terminal: /home/seth/receipts/chart.svg");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("The desktop window's preview draws this page, not the terminal: /home/seth/receipts/site/index.html");
    // The list stays open, and no markup reached the frame.
    expect(listed(app)).toHaveLength(2);
    expect(app.frame()).not.toContain("<h1>");
    expect(env.requests("files.read")).toEqual([]);
  });

  it("opens a document past the pager's 2 MiB read at its first part, saying how much was cut, and marks a binary one without drawing or copying it", async () => {
    const MIB = 1024 * 1024;
    const { app, env, runId } = await launch({
      fileContents: { "big.md": { text: "# Big\n\nThe first part.\n", truncated: true, size: 3 * MIB }, "blob.md": { binary: true, size: 4096 } },
    });
    // Edited as Claude's Edit does: what the environment holds there stays as the script gave it.
    for (const path of ["big.md", "blob.md"]) {
      const toolCallId = `edit-${path}`;
      env.emit(SESSION, "tool.started", { runId, toolCallId, name: "Edit", input: { file_path: `${WORKSPACE}/${path}`, old_string: "a", new_string: "b" }, title: null, agentId: null, parentToolCallId: null });
      env.emit(SESSION, "tool.ended", { runId, toolCallId, status: "ok", output: null, durationMs: 5 });
    }
    await command(app, "/documents");
    await app.waitUntil(() => listed(app).length === 2, "the two documents listed");

    await app.press(KEY.enter);
    await app.waitFor("A binary file of 4.0 KB: not shown as text.");
    expect(app.frame()).toContain("blob.md · 4.0 KB · binary");
    await app.press("y");
    await app.waitFor("Nothing here to copy: y copies a file or a document read in the pager.");

    await app.press("q");
    await app.waitFor("Documents");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("The first part.");
    expect(app.frame()).toContain("big.md · 3.0 MB · the first 2 MiB");
    expect(app.frame()).toContain("… cut at 2 MiB: the last 1.0 MB of 3.0 MB is not shown.");
    await app.press("y");
    await app.waitFor("Copied the first 2 MiB of big.md.");
    expect(app.clipboard.copied).toEqual(["# Big\n\nThe first part.\n"]);
  });

  it("is in /help with the pager's copy key, both answered, and in the command menu, which runs it", async () => {
    const { app } = await launch();
    await command(app, "/help");
    /** The overlay's row holding `text`, paged down to. */
    const pageTo = async (text: string) => {
      const rowOf = () => app.rows().find((row) => row.includes(text));
      for (let i = 0; i < 40 && rowOf() === undefined; i++) await app.press(KEY.pageDown);
      return rowOf() ?? `no row holds ${text}`;
    };
    const copyRow = await pageTo("Copy the file or document the page reads, whole");
    expect(copyRow).toMatch(/\sy\s+Copy the file/);
    expect(copyRow).not.toContain("(soon)");
    const documentsRow = await pageTo("The pages, SVGs and markdown this session wrote");
    expect(documentsRow).toContain("/documents");
    expect(documentsRow).not.toContain("(soon)");
    await app.press(KEY.esc);

    await app.type("/docu");
    await app.waitFor("/documents");
    await app.press(KEY.enter);
    await app.waitFor("No pages, SVGs or markdown written yet.");
  });
});
