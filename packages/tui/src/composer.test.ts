import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKeymap } from "./keys.js";
import { DRAFT_DEBOUNCE_MS } from "@agent-harness/client-runtime";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The composer (docs/specs/tui.md, "The composer"; #146): sending as
 * `runs.start` or `runs.send` under `runs:drive`, steering or queueing
 * during a live run, Esc interrupting, attachments on the send's field, the
 * lock while the environment cannot be reached, the draft as a session
 * field, the carried slash commands and the command menu, `@` over the
 * workspace's `files.list`, and what stays client-local: history, snippets,
 * paste chips, Ctrl+V images and Ctrl+G.
 */

let apps: RenderedApp[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";

const launch = async (environment: Partial<ScriptedEnvironment> = {}, extra: Partial<Parameters<typeof renderApp>[0]> = {}) => {
  const app = await renderApp({
    script: {
      environments: [
        {
          name: "desk",
          reach: "local",
          sessions: [
            { title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } },
            { title: "Parser", workspace: { kind: "directory", path: "/home/seth/parser" } },
          ],
          ...environment,
        },
      ],
    },
    flags: { session: SESSION },
    ...extra,
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const paramsOf = (app: RenderedApp, method: string) => app.environment("desk").requests(method).map((request) => request.params);

const send = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

describe("prompt suggestions (#251)", () => {
  it.each(["2", "3", "4"])("takes the offer with the explicitly remapped digit %s", async (digit) => {
    const { app, env } = await launch({}, { keymap: resolveKeymap({ "composer.suggestion.take": [digit] }).keymap });
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.endRun(SESSION, runId);
    env.emit(SESSION, "run.suggested", { runId, suggestion: "Run the tests" });
    await app.waitFor(`[${digit}] Run the tests`);
    await app.press(digit);
    await app.waitFor("▌ Run the tests");
    expect(paramsOf(app, "runs.start")).toEqual([expect.objectContaining({ text: "Run the tests" })]);
  });

  it("can retry the offer after a refused send restores its text to the draft", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.endRun(SESSION, runId);
    env.emit(SESSION, "run.suggested", { runId, suggestion: "Run the tests" });
    env.wire.answer("runs.start", () => ({ error: { code: "conflict", message: "Refused for test", data: {} } }));
    await app.waitFor("[1] Run the tests");
    await app.press("1");
    await app.waitFor("› Run the tests");
    await app.press(KEY.ctrlU);
    await app.press("1");
    await app.waitUntil(() => paramsOf(app, "runs.start").length === 2, "the offer to be retried");
  });

  it("uses the remapped suggestion action and sends slash text literally", async () => {
    const { app, env } = await launch({}, { keymap: resolveKeymap({ "composer.suggestion.take": ["Ctrl+X"] }).keymap });
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.endRun(SESSION, runId);
    env.emit(SESSION, "run.suggested", { runId, suggestion: "/help me check the fix" });
    await app.waitFor("[Ctrl+X] /help me check the fix");
    await app.press("\u0018");
    await app.waitFor("▌ /help me check the fix");
    expect(paramsOf(app, "runs.start")[0]).toMatchObject({ text: "/help me check the fix" });
  });

  it("leaves 1 without an offer and 2–4 as text, and never replaces a typed draft", async () => {
    const { app, env } = await launch();
    await app.press("1");
    await app.waitFor("› 1");
    await app.press(KEY.ctrlU);
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.endRun(SESSION, runId);
    env.emit(SESSION, "run.suggested", { runId, suggestion: "Add a regression test" });
    await app.waitFor("[1] Add a regression test");
    await app.type("234");
    await app.press("1");
    await app.waitFor("› 2341");
    expect(paramsOf(app, "runs.start")).toEqual([]);
    expect(paramsOf(app, "runs.send")).toEqual([]);
  });

  it("shows the completed run's offer and sends it with 1 from an empty composer, then clears it", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.endRun(SESSION, runId);
    env.emit(SESSION, "run.suggested", { runId, suggestion: "Add a regression test" });
    await app.waitFor("[1] Add a regression test");
    await app.press("1");
    await app.waitFor("▌ Add a regression test");
    expect(paramsOf(app, "runs.start")).toEqual([expect.objectContaining({ text: "Add a regression test" })]);
    expect(app.frame()).not.toContain("[1] Add a regression test");
  });
});

describe("sending", () => {
  it("starts a run with runs.start when none is live, and draws the message", async () => {
    const { app } = await launch();
    await send(app, "Fix the receipts");
    await app.waitFor("▌ Fix the receipts");
    expect(paramsOf(app, "runs.start")).toEqual([expect.objectContaining({ sessionId: SESSION, text: "Fix the receipts" })]);
    expect(paramsOf(app, "runs.send")).toEqual([]);
    expect(app.frame()).toContain("steer or queue a message");
  });

  it("sends with runs.send during a live run, and the message waits on the queued line", async () => {
    const { app } = await launch();
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    await send(app, "and the tests");
    await app.waitFor("⧗ queued and the tests");
    expect(paramsOf(app, "runs.send")).toEqual([expect.objectContaining({ sessionId: SESSION, text: "and the tests" })]);
    // A queued message is on the queued line, not a row of the transcript yet.
    expect(app.rows().filter((row) => row.includes("and the tests"))).toHaveLength(1);
  });

  it("says a message sent during a live run is being steered when the provider holds it and its adapter steers", async () => {
    const { app } = await launch({ queue: "provider", provider: { providerQueue: true, steering: true } });
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    await send(app, "use the other parser");
    await app.waitFor("↳ steering use the other parser");
  });

  it("takes the provider from the session's account when the environment has several", async () => {
    const { app } = await launch({
      sessions: [{ title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" }, accountId: "account-2" }],
      providers: [{}, { provider: "codex", displayName: "Codex", providerQueue: true, steering: true }],
      accounts: [{}, { provider: "codex" }],
      queue: "provider",
    });
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    await send(app, "use the other parser");
    await app.waitFor("↳ steering use the other parser");
  });

  it.each([KEY.esc, KEY.ctrlC])("interrupts the live run with the default stop key %j", async (key) => {
    const { app, env } = await launch();
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    const runId = env.liveRun(SESSION);
    await app.press(key);
    await app.waitFor("✗ Interrupted");
    expect(paramsOf(app, "runs.interrupt")).toEqual([expect.objectContaining({ runId })]);
    await app.waitFor("message the agent");
  });

  it("refuses at once with one line while the environment cannot be reached, the composer locked with the reason", async () => {
    const { app, env } = await launch();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("Locked: desk cannot be reached.");
    await send(app, "Fix the receipts");
    await app.waitFor("Not sent: desk cannot be reached.");
    // Nothing was sent, and the text is still there to send later.
    expect(app.frame()).toContain("Fix the receipts");
    expect(env.requests("runs.start")).toEqual([]);
  });

  it("puts an attachment read with /attach on the send's field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-attach-"));
    dirs.push(dir);
    writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { app } = await launch({}, { cwd: dir });
    await send(app, "/attach shot.png");
    await app.waitFor("attached: shot.png");
    await send(app, "What is this?");
    await app.waitFor("▌ What is this?");
    expect(paramsOf(app, "runs.start")).toEqual([
      expect.objectContaining({ text: "What is this?", attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", data: "iVBORw==" }] }),
    ]);
    expect(app.frame()).toContain("[image shot.png");
  });

  it("refuses at /attach a file the session's provider cannot take", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-attach-"));
    dirs.push(dir);
    writeFileSync(join(dir, "notes.pdf"), "%PDF");
    const { app } = await launch({}, { cwd: dir });
    await app.tick(5);
    await send(app, "/attach notes.pdf");
    await app.waitFor("Claude takes images but no other files: notes.pdf was not attached.");
    expect(app.frame()).not.toContain("attached: notes.pdf");
  });

  it("pastes an image off the clipboard with Ctrl+V as a chip, sent as an attachment", async () => {
    const { app } = await launch();
    app.clipboard.hold({ image: Uint8Array.of(1, 2, 3) });
    await app.type("Look at ");
    await app.press(KEY.ctrlV);
    await app.waitFor("› Look at [Image #1]");
    await app.press(KEY.enter);
    await app.waitUntil(() => paramsOf(app, "runs.start").length === 1, "the start to be sent");
    expect(paramsOf(app, "runs.start")[0]).toMatchObject({ text: "Look at [Image #1]", attachments: [{ kind: "image", name: "clipboard-1.png", mediaType: "image/png", data: "AQID" }] });
  });
});

describe("the draft", () => {
  it("never saves a terminal command or its prefixes when typed one character at a time", async () => {
    const { app } = await launch();
    for (const key of "/pin") {
      await app.type(key);
      await app.jump(DRAFT_DEBOUNCE_MS + 100);
      expect(paramsOf(app, "sessions.setDraft")).toEqual([]);
    }
    await app.press(KEY.enter);
    await app.waitUntil(() => paramsOf(app, "sessions.pin").length === 1, "the pin command to run");
    await app.jump(DRAFT_DEBOUNCE_MS + 100);
    expect(paramsOf(app, "sessions.setDraft")).toEqual([]);
  });

  it("saves a slash-prefixed message once words follow the first slash word", async () => {
    const { app } = await launch();
    for (const key of "/usr/bin") await app.type(key);
    await app.jump(DRAFT_DEBOUNCE_MS + 100);
    expect(paramsOf(app, "sessions.setDraft")).toEqual([]);
    for (const key of " is broken") await app.type(key);
    await app.jump(DRAFT_DEBOUNCE_MS + 100);
    await app.waitUntil(() => paramsOf(app, "sessions.setDraft").length === 1, "the slash-prefixed message to be saved");
    expect(paramsOf(app, "sessions.setDraft")).toEqual([expect.objectContaining({ sessionId: SESSION, draft: "/usr/bin is broken" })]);
  });

  it("keeps a terminal command with arguments out of the draft, including the trust command from #516", async () => {
    const { app } = await launch();
    await app.type("/trust decline");
    await app.jump(DRAFT_DEBOUNCE_MS + 100);
    expect(paramsOf(app, "sessions.setDraft")).toEqual([]);
  });

  it("is saved as the session's field a second after the last key", async () => {
    const { app } = await launch();
    await app.type("half a thought");
    await app.advance(DRAFT_DEBOUNCE_MS - 100);
    expect(paramsOf(app, "sessions.setDraft")).toEqual([]);
    await app.advance(200);
    await app.waitUntil(() => paramsOf(app, "sessions.setDraft").length === 1, "the draft to be saved");
    expect(paramsOf(app, "sessions.setDraft")).toEqual([expect.objectContaining({ sessionId: SESSION, draft: "half a thought" })]);
  });

  it("is restored when switching sessions, and a command typed for the terminal is never saved as one", async () => {
    const { app } = await launch({
      sessions: [
        { title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } },
        { title: "Parser", workspace: { kind: "directory", path: "/home/seth/parser" }, draft: "left on the laptop" },
      ],
    });
    await send(app, "/resume");
    await app.waitFor("Sessions");
    await app.type("Pars");
    await app.press(KEY.enter);
    await app.waitFor("› left on the laptop");
    await app.press(KEY.ctrlU);
    await send(app, "/resume");
    await app.type("Rec");
    await app.press(KEY.enter);
    await app.waitFor("message the agent");
    await app.advance(DRAFT_DEBOUNCE_MS + 100);
    await app.waitUntil(() => paramsOf(app, "sessions.setDraft").length === 1, "the cleared draft to be saved");
    // Only the draft cleared in Parser was saved; neither "/resume" was.
    expect(paramsOf(app, "sessions.setDraft")).toEqual([expect.objectContaining({ sessionId: "0199aa00-0000-4000-8000-000000000002", draft: null })]);
  });

  it("takes a draft another client saved while nothing was typed over it here", async () => {
    const { app, env } = await launch();
    env.emit(SESSION, "session.draft-set", { draft: "typed on the laptop" }, { fields: { draft: "typed on the laptop" } });
    await app.waitFor("› typed on the laptop");
  });
});

describe("slash commands", () => {
  it("opens the command menu on / and runs the highlighted command on Enter", async () => {
    const { app } = await launch({ commands: [{ kind: "command", name: "compact", description: "Compact the conversation", builtin: true }] });
    await app.type("/ta");
    await app.waitFor("/tasks");
    await app.press(KEY.enter);
    await app.waitFor("Tasks");
    await app.press(KEY.esc);
    await app.type("/comp");
    await app.waitFor("Compact the conversation · the agent's");
  });

  it("lists its own commands, then the open session's skills with slash-only ones marked, then the provider's, from commands.list asked for the open session (#503)", async () => {
    const { app } = await launch({
      commands: [
        { kind: "skill", name: "commit", description: "Write the commit", invocation: "slash-only", origin: null, alwaysOn: false, argumentHint: "[message]" },
        { kind: "skill", name: "cover", description: "Raise the coverage", invocation: "model+slash", origin: null, alwaysOn: false, argumentHint: null },
        { kind: "command", name: "compact", description: "Compact the conversation", builtin: true },
      ],
    });
    await app.type("/co");
    await app.waitFor("Compact the conversation · the agent's");
    const frame = app.frame();
    const at = (text: string) => frame.indexOf(text);
    expect([at("/copy"), at("/commit [message]"), at("/cover"), at("/compact")].every((place, index, all) => place !== -1 && (index === 0 || (all[index - 1] ?? -1) < place))).toBe(true);
    expect(frame).toContain("Write the commit · slash-only");
    expect(frame).toContain("Raise the coverage");
    expect(frame).not.toContain("Raise the coverage ·");
    expect(paramsOf(app, "commands.list")).toEqual([{ sessionId: SESSION }]);
  });

  it("offers a skill its own /new shadows as /skill:new, and fills in a skill that takes words with a space after it", async () => {
    const { app } = await launch({
      commands: [
        { kind: "skill", name: "new", description: "Draft a new module", invocation: "model+slash", origin: null, alwaysOn: false, argumentHint: null },
        { kind: "skill", name: "triage", description: "Triage the issues", invocation: "model+slash", origin: null, alwaysOn: false, argumentHint: "<label>" },
      ],
    });
    await app.type("/skill:n");
    await app.waitFor("Draft a new module");
    await app.press(KEY.enter);
    await app.waitFor("▌ /skill:new");
    expect(paramsOf(app, "runs.start")).toEqual([expect.objectContaining({ text: "/skill:new" })]);

    await app.type("/tria");
    await app.waitFor("/triage <label>");
    await app.press(KEY.tab);
    await app.waitFor("› /triage ");
  });

  it("types ? into /resume's filter rather than opening the keys", async () => {
    const { app } = await launch({
      sessions: [
        { title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } },
        { title: "Why is it slow?", workspace: { kind: "directory", path: "/home/seth/parser" } },
      ],
    });
    await send(app, "/resume");
    await app.waitFor("Sessions");
    await app.type("slow?");
    await app.waitFor("filter slow?");
    expect(app.frame()).not.toContain("everything the terminal answers");
    expect(app.frame()).toContain("Why is it slow?");
    // Under the header, which names the open session, the list holds only the match; the rail beside it lists every session.
    expect(app.rows().slice(1).map((row) => row.split("│").at(-1) ?? row).filter((row) => row.includes("Receipts"))).toEqual([]);
  });

  it("sends a command it does not know to the agent as typed", async () => {
    const { app } = await launch();
    await send(app, "/compact keep the tests");
    await app.waitFor("▌ /compact keep the tests");
    expect(paramsOf(app, "runs.start")).toEqual([expect.objectContaining({ text: "/compact keep the tests" })]);
  });

  it("answers /profile as the hidden alias of /account, never sending it", async () => {
    const { app } = await launch();
    await send(app, "/profile");
    await app.waitFor("Accounts on desk");
    expect(paramsOf(app, "runs.start")).toEqual([]);
  });

  it("starts a session with /new on the same environment, in the open session's workspace through a session request", async () => {
    const { app } = await launch();
    await send(app, "/new");
    await app.waitFor("A new session on desk in /home/seth/receipts.");
    await app.waitFor("Nothing said yet.");
    expect(paramsOf(app, "sessions.create")).toEqual([expect.objectContaining({ workspace: { kind: "session", sessionId: SESSION } })]);
    const created = String(paramsOf(app, "sessions.create")[0]?.["id"]);
    expect(app.environment("desk").list.summaries().find((summary) => summary.id === created)?.workspace).toEqual({ kind: "directory", path: "/home/seth/receipts" });
    await send(app, "Hello");
    await app.waitUntil(() => paramsOf(app, "runs.start").length === 1, "a start");
    expect(paramsOf(app, "runs.start")[0]).toMatchObject({ sessionId: paramsOf(app, "sessions.create")[0]?.["id"], text: "Hello" });
  });

  it("keeps snippets in the state directory and expands one with /snip, Tab walking its slots", async () => {
    const { app } = await launch();
    await send(app, "/snip save explain Explain @${1:path}: what it is for, then $2.");
    await app.waitFor("Saved ;;explain.");
    // "Saved" is said before the file is written (#262), so wait on the file, not the line.
    await app.waitUntil(() => {
      try {
        const kept = JSON.parse(readFileSync(join(app.stateDir, "snippets.json"), "utf8")) as { snippets: { name: string }[] };
        return kept.snippets.map((s) => s.name).join() === "explain";
      } catch {
        return false;
      }
    }, "the snippet to be written");
    await send(app, "/snip explain");
    await app.waitFor("› Explain @path: what it is for, then .");
    await app.type("src/a.ts");
    await app.press(KEY.tab);
    await app.type("the callers");
    expect(app.frame()).toContain("› Explain @src/a.ts: what it is for, then the callers.");
  });

  it("says so when a saved snippet cannot be written, and keeps it for this run", async () => {
    const { app } = await launch();
    // A directory where the file should be: the read finds no snippets, the rename fails.
    mkdirSync(join(app.stateDir, "snippets.json"));
    await send(app, "/snip save notes Remember $1.");
    await app.waitFor("The snippets could not be written");
    await send(app, "/snip notes");
    await app.waitFor("› Remember .");
  });

  it("lists the delegated work with /tasks and quits with /quit", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Go");
    env.emit(SESSION, "tasks.changed", {
      runId,
      tasks: [
        { taskId: "task-1", kind: "local_agent", description: "Find the parser", status: "running", startedAt: app.clock.now().toISOString(), endedAt: null, subagentType: "Explore", toolCallId: "t9", error: null },
      ],
    });
    await app.waitFor("⤷ Explore: Find the parser · running");
    await send(app, "/tasks");
    await app.waitFor("Explore: Find the parser · running");
    await app.press(KEY.esc);
    await send(app, "/quit");
    const frames = app.frames();
    await app.type("x");
    await app.tick(2);
    expect(app.frames()).toBe(frames);
  });
});

describe("@ names a file", () => {
  it("lists the workspace through files.list on the session's environment, ranked by the fuzzy scorer", async () => {
    const { app } = await launch({ files: ["README.md", "src/parser.ts", "src/receipts/parse.ts", "test/parser.test.ts"] });
    await app.type("Look at @prs");
    await app.waitFor("@src/parser.ts");
    const rows = app.rows();
    expect(rows.findIndex((row) => row.includes("@src/parser.ts"))).toBeLessThan(rows.findIndex((row) => row.includes("@test/parser.test.ts")));
    await app.press(KEY.tab);
    expect(app.frame()).toContain("› Look at @src/parser.ts");
    expect(paramsOf(app, "files.list")).toEqual([{ sessionId: SESSION }]);
  });
});

describe("what stays client-local", () => {
  it("closes a reverse search on Ctrl+V, keeping the match, and pastes after it", async () => {
    const { app } = await launch();
    await send(app, "first prompt");
    await app.waitFor("▌ first prompt");
    await app.press(KEY.esc);
    await app.waitFor("message the agent");
    await app.press(KEY.ctrlR);
    await app.type("first");
    await app.waitFor("(search this session) first");
    app.clipboard.hold({ text: " and more" });
    await app.press(KEY.ctrlV);
    await app.waitFor("› first prompt and more");
    expect(app.frame()).not.toContain("(search");
  });

  it("keeps the prompt history in the state directory and walks it with ↑", async () => {
    const { app } = await launch();
    await send(app, "first prompt");
    await app.waitFor("▌ first prompt");
    await app.press(KEY.esc);
    await app.waitFor("message the agent");
    await app.press(KEY.up);
    expect(app.frame()).toContain("› first prompt");
    await app.waitUntil(() => {
      try {
        return readFileSync(join(app.stateDir, "history.jsonl"), "utf8").includes("first prompt");
      } catch {
        return false;
      }
    }, "the history to be written");
  });

  it("stands a long paste in the text as a chip and sends what it stood for", async () => {
    const { app } = await launch();
    const trace = ["TypeError: x is undefined", "    at parse (src/parser.ts:12:3)", "    at main (src/app.ts:4:1)", "    at run (src/run.ts:9:9)"].join("\n");
    await app.type("Why? ");
    await app.paste(trace);
    await app.waitFor("[Pasted #1 · 4 lines");
    await app.press(KEY.enter);
    await app.waitUntil(() => paramsOf(app, "runs.start").length === 1, "a start");
    expect(paramsOf(app, "runs.start")[0]?.["text"]).toContain("at parse (src/parser.ts:12:3)");
  });

  it("hands the text to the editor on Ctrl+G and takes it back", async () => {
    const { app } = await launch();
    await app.type("a draft");
    await app.press(KEY.ctrlG);
    await app.waitFor("› a draft (edited)");
  });

  it("keeps a pasted image through Ctrl+G while its marker is still in the text", async () => {
    const { app } = await launch();
    app.clipboard.hold({ image: Uint8Array.of(1, 2, 3) });
    await app.type("See ");
    await app.press(KEY.ctrlV);
    await app.waitFor("› See [Image #1]");
    await app.press(KEY.ctrlG);
    await app.waitFor("› See [Image #1] (edited)");
    await app.press(KEY.enter);
    await app.waitUntil(() => paramsOf(app, "runs.start").length === 1, "the start to be sent");
    expect(paramsOf(app, "runs.start")[0]).toMatchObject({ text: "See [Image #1] (edited)", attachments: [{ name: "clipboard-1.png" }] });
  });

  it("keeps a line open with a backslash before Enter", async () => {
    const { app } = await launch();
    await app.type("one");
    await app.press("\\", KEY.enter);
    await app.type("two");
    expect(app.frame()).toContain("› one");
    expect(app.frame()).toContain("  two");
    expect(paramsOf(app, "runs.start")).toEqual([]);
  });
});

describe("the transcript's keys", () => {
  it("recalls the command a call ran with r behind `!`, so Enter runs it in the session's terminal, and unfolds a row with Enter", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Run the tests");
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "pnpm test --filter tui" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(SESSION, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: "all green", durationMs: 1200 });
    await app.waitFor("◆ Ran a command");
    await app.press(KEY.tab, KEY.tab);
    await app.waitFor("The transcript has the keys");
    await app.press(KEY.up);
    await app.press(KEY.enter);
    await app.waitFor("Bash(pnpm test --filter tui)");
    await app.waitFor("all green");
    await app.press("r");
    await app.waitFor("› !pnpm test --filter tui");
  });

  it("stops a running call with x: its delegated work by runs.stopTask, else the run by runs.interrupt", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Explore");
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Task", input: { description: "Find it" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(SESSION, "tasks.changed", {
      runId,
      tasks: [{ taskId: "task-1", kind: "local_agent", description: "Find it", status: "running", startedAt: app.clock.now().toISOString(), endedAt: null, subagentType: "Explore", toolCallId: "t1", error: null }],
    });
    await app.waitFor("Task(Find it)");
    await app.press(KEY.tab, KEY.tab, KEY.tab, KEY.up);
    await app.press("x");
    await app.waitUntil(() => paramsOf(app, "runs.stopTask").length === 1, "the task to be stopped");
    expect(paramsOf(app, "runs.stopTask")[0]).toMatchObject({ runId, taskId: "task-1" });
  });

  it("opens the pager on Ctrl+O over the whole transcript unfolded, and closes it on q", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Look");
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Read", input: { file_path: "a.ts" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(SESSION, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: "line one\nline two", durationMs: 5 });
    env.endRun(SESSION, runId);
    await app.waitFor("◆ Read a file");
    expect(app.frame()).not.toContain("Read(a.ts)");
    await app.press(KEY.ctrlO);
    await app.waitFor("Read(a.ts)");
    expect(app.frame()).toContain("line two");
    // A search typed at the pager takes text, not a Tab.
    await app.press("/", KEY.tab);
    await app.type("line two");
    await app.press(KEY.enter);
    await app.waitFor("1 match for line two");
    await app.press("q");
    await app.waitUntil(() => !app.frame().includes("Read(a.ts)"), "the pager to close");
  });

  it("copies the last reply, or one of its code blocks, with /copy, and writes the conversation with /export", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Show me");
    env.emit(SESSION, "assistant.text", { runId, itemId: "i-1", text: "Here:\n```ts\nconst a = 1;\n```\nand\n```\nls\n```", aborted: false });
    env.endRun(SESSION, runId);
    await app.waitFor("● Here:");
    await send(app, "/copy 2");
    await app.waitFor("Copied code block 2.");
    expect(app.clipboard.copied).toEqual(["ls"]);
    await send(app, "/export talk.md");
    await app.waitFor("Wrote the conversation to");
    const written = readFileSync(join(app.stateDir, "talk.md"), "utf8");
    expect(written).toContain("# Receipts");
    expect(written).toContain("Show me");
    expect(written).toContain("const a = 1;");
  });

  it("shows one line per turn with /timeline", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Fix the parser");
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Edit", input: { file_path: "src/parser.ts" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(SESSION, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: "ok", durationMs: 5 });
    env.endRun(SESSION, runId, { durationMs: 3000 });
    await app.waitFor("3.0s");
    await send(app, "/timeline");
    await app.waitFor("Fix the parser · 3.0s · 1 file");
  });
});
