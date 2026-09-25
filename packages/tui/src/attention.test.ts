import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * Attention (docs/specs/tui.md, "Attention"; #149): the runtime's attention
 * events drive Artemis's attention module. The title says what every session
 * across the environments is doing; the bell (or an OSC notification) rings
 * after six seconds of an unanswered prompt, or sixty after the open
 * session's turn finished, with no key pressed; a key pushes both back; and
 * the key that ends three minutes of stillness says what happened meanwhile.
 * The chrome is the harness's recorder: what the screen would ask of the
 * terminal, never a real title or bell.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const RECEIPTS = "0199aa00-0000-4000-8000-000000000001";
const NOTES = "0199aa00-0000-4000-8000-000000000002";

const launch = async () => {
  const app = await renderApp({
    script: {
      environments: [
        {
          name: "desk",
          reach: "local",
          sessions: [
            { title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } },
            { title: "Notes", workspace: { kind: "directory", path: "/home/seth/notes" } },
          ],
        },
      ],
    },
    flags: { session: RECEIPTS },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, desk: app.environment("desk") };
};

const lastTitle = (app: RenderedApp) => (app.chrome.titles.at(-1) ?? "").trimEnd();

describe("the title", () => {
  it("says what every session is doing: ready, working while a run goes anywhere, needs you while a prompt waits anywhere", async () => {
    const { app, desk } = await launch();
    await app.waitUntil(() => lastTitle(app) === "◇ ready · Receipts (/home/seth/receipts)", "the title ready");
    const { runId } = desk.startRun(NOTES, "Tidy the notes");
    await app.waitUntil(() => lastTitle(app).startsWith("⠹ working · Receipts"), "the title working");
    desk.openPrompt(NOTES, { runId });
    await app.waitUntil(() => lastTitle(app).startsWith("⚿ needs you · Receipts"), "the title needing you");
    expect(app.chrome.titles.every((title) => [...title].length === 80)).toBe(true);
  });

  it("hands the title back when the terminal UI goes", async () => {
    const { app } = await launch();
    await app.waitUntil(() => app.chrome.titles.length > 0, "a title set");
    const chrome = app.chrome;
    await app.unmount();
    apps = apps.filter((one) => one !== app);
    expect(chrome.cleared()).toBe(1);
  });
});

describe("the bell", () => {
  it("rings six seconds after a prompt parks with no key pressed, and a key pushes it back", async () => {
    const { app, desk } = await launch();
    desk.startRun(RECEIPTS, "Clean the build");
    desk.openPrompt(RECEIPTS);
    await app.waitFor("⚿ Permission");
    await app.jump(4_000);
    await app.press("k");
    await app.jump(4_000);
    expect(app.chrome.notices).toEqual([]);
    await app.jump(2_000);
    expect(app.chrome.notices).toEqual([{ kind: "needs-you", title: "Receipts", body: "Bash is waiting for permission" }]);
    await app.jump(60_000);
    expect(app.chrome.notices).toHaveLength(1);
  });

  it("rings for a prompt parked on any environment's session, not only the one open, and not at all once it is answered", async () => {
    const { app, desk } = await launch();
    const { runId } = desk.startRun(NOTES, "Tidy the notes");
    const promptId = desk.openPrompt(NOTES, { runId, kind: "question", toolName: "AskUserQuestion", input: null, summary: "Which folder?" });
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 1, "the prompt parked");
    await app.jump(6_000);
    expect(app.chrome.notices).toEqual([{ kind: "needs-you", title: "Notes", body: "A question is waiting for an answer" }]);

    const again = desk.openPrompt(NOTES, { runId });
    await app.tick(2);
    desk.answerElsewhere(NOTES, promptId);
    desk.answerElsewhere(NOTES, again);
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 0, "the prompts answered");
    await app.jump(10_000);
    expect(app.chrome.notices).toHaveLength(1);
  });

  it("rings sixty seconds after the open session's turn finished, with the first line of its reply", async () => {
    const { app, desk } = await launch();
    const { runId } = desk.startRun(RECEIPTS, "Fix the receipts");
    desk.emit(RECEIPTS, "assistant.text", { runId, itemId: "i-1", text: "\nFixed the rounding.\nIt was the tax line.", aborted: false });
    desk.endRun(RECEIPTS, runId);
    await app.waitFor("Fixed the rounding.");
    await app.jump(59_000);
    expect(app.chrome.notices).toEqual([]);
    await app.jump(1_000);
    expect(app.chrome.notices).toEqual([{ kind: "finished", title: "Receipts", body: "Fixed the rounding." }]);
  });

  it("names the session whose turn finished, and its reply, even when another session is open when it rings", async () => {
    const { app, desk } = await launch();
    const notes = desk.startRun(NOTES, "Tidy the notes");
    desk.emit(NOTES, "assistant.text", { runId: notes.runId, itemId: "n-1", text: "Tidied an hour ago.", aborted: false });
    desk.endRun(NOTES, notes.runId);
    const { runId } = desk.startRun(RECEIPTS, "Fix the receipts");
    desk.emit(RECEIPTS, "assistant.text", { runId, itemId: "i-1", text: "Fixed the rounding.", aborted: false });
    desk.endRun(RECEIPTS, runId);
    await app.waitFor("Fixed the rounding.");
    await app.type("/resume");
    await app.press(KEY.enter);
    await app.type("Notes");
    await app.press(KEY.enter);
    await app.waitFor("Tidied an hour ago.");
    await app.jump(60_000);
    expect(app.chrome.notices).toEqual([{ kind: "finished", title: "Receipts", body: "Fixed the rounding." }]);
  });
});

describe("the away summary", () => {
  it("says what happened on the key that ends three minutes of stillness, and nothing on the next", async () => {
    const { app, desk } = await launch();
    await app.jump(60_000);
    const { runId } = desk.startRun(NOTES, "Tidy the notes");
    desk.endRun(NOTES, runId, { durationMs: 130_000 });
    await app.jump(3 * 60_000);
    await app.press("x");
    await app.waitFor("while you were away: Notes finished");
    await app.press(KEY.backspace);
    await app.jump(9_000);
    expect(app.frame()).not.toContain("while you were away");
  });
});
