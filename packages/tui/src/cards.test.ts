import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type EnvironmentHandle, type RenderedApp } from "../test/harness.js";

/**
 * The permission and question cards (docs/specs/tui.md, "Cards:
 * permissions, questions, parked asks"; #149): a parked prompt of the open
 * session is the card below the transcript and above the composer,
 * the cursor on Deny so a bare Enter never authorises; Tab adds a note, Space
 * ticks a question's options, `e` and `s` keep their keys and say why they
 * do nothing; the "for this session" row answers `remember: 'session'` on a
 * permission prompt only; a plan's approval carries the mode to continue in
 * only when one is chosen. The answer is `permissions.prompts.answer`, never
 * queued: refused at once while the environment cannot be reached, and sent
 * again with its command id after a mid-flight drop, so it applies once.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";

/** The local environment with one session, opened, a run going on it. */
const opened = async (extra: Partial<Parameters<typeof renderApp>[0]> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } }] }] },
    flags: { session: SESSION },
    ...extra,
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  env.startRun(SESSION, "Clean the build");
  await app.waitFor("▌ Clean the build");
  return { app, env };
};

/** Parks a prompt and waits for its card. */
const park = async (app: RenderedApp, env: EnvironmentHandle, prompt: ScriptedPrompt = {}, heading = "⚿ Permission") => {
  const promptId = env.openPrompt(SESSION, prompt);
  await app.waitFor(heading);
  return promptId;
};

/** The params of every `permissions.prompts.answer` the terminal sent on the latest socket. */
const answersSent = (env: EnvironmentHandle) => env.requests("permissions.prompts.answer").map((r) => r.params);

const rowOf = (app: RenderedApp, text: string) => app.rows().findIndex((row) => row.includes(text));

describe("the permission card", () => {
  it("draws a parked prompt below the transcript and above the composer, the cursor on Deny, and a bare Enter denies", async () => {
    const { app, env } = await opened();
    const promptId = await park(app, env);
    expect(app.frame()).toContain("❯ Deny");
    expect(app.frame()).toContain("Allow once");
    expect(app.frame()).toContain("$ rm -rf build");
    // Below the transcript, above the composer; the transcript no longer draws it as a row waiting.
    expect(rowOf(app, "⚿ Permission")).toBeGreaterThan(rowOf(app, "▌ Clean the build"));
    expect(rowOf(app, "⚿ Permission")).toBeLessThan(app.rows().findIndex((row) => row.startsWith("› ")));
    expect(app.frame()).not.toContain("waiting for an answer");

    await app.press(KEY.enter);
    await app.waitUntil(() => answersSent(env).length === 1, "an answer sent");
    expect(answersSent(env)[0]).toEqual({ commandId: expect.any(String), promptId, sessionId: SESSION, decision: "deny" });
    await app.waitFor("Bash: rm -rf build — denied");
    expect(app.frame()).not.toContain("⚿ Permission");
  });

  it("allows once from the next row, and answers remember session from the for-this-session row", async () => {
    const { app, env } = await opened();
    await park(app, env);
    await app.press(KEY.down);
    expect(app.frame()).toContain("❯ Allow once");
    await app.press(KEY.enter);
    await app.waitFor("Bash: rm -rf build — allowed");

    await park(app, env);
    await app.press("j", "j");
    expect(app.frame()).toContain("❯ Allow for this session");
    await app.press(KEY.enter);
    await app.waitFor("— allowed for this session");
    expect(answersSent(env).map((p) => [p["decision"], p["remember"]])).toEqual([
      ["allow", undefined],
      ["allow", "session"],
    ]);
  });

  it("denies on Esc, with the note Tab added; Esc in the note's line closes it and decides nothing", async () => {
    const { app, env } = await opened();
    await park(app, env);
    await app.press(KEY.tab);
    await app.waitFor("✎");
    await app.type("use make clean");
    await app.press(KEY.esc);
    await app.waitFor("note: use make clean");
    expect(answersSent(env)).toEqual([]);
    await app.press(KEY.esc);
    await app.waitUntil(() => answersSent(env).length === 1, "an answer sent");
    expect(answersSent(env)[0]).toMatchObject({ decision: "deny", message: "use make clean" });
    await app.waitFor("denied: use make clean");
  });

  it("keeps e and s, drawn dim, answering absent with the reason rules are per session", async () => {
    const { app, env } = await opened();
    await park(app, env);
    expect(app.frame()).toContain("e s: rules are per session on the harness");
    await app.press("e");
    await app.waitFor("Rules are per session on the harness");
    await app.press("s");
    expect(answersSent(env)).toEqual([]);
    expect(app.frame()).toContain("❯ Deny");
  });

  it("gives a denylist prompt no for-this-session row, and names what it matched", async () => {
    const { app, env } = await opened();
    await park(
      app,
      env,
      {
        kind: "denylist",
        toolName: "Read",
        input: { file_path: "/home/seth/.ssh/id_ed25519" },
        summary: "Read: /home/seth/.ssh/id_ed25519",
        denylist: [{ section: "paths", entry: { id: "ssh", pattern: "~/.ssh/**", note: "", enabled: true, preset: true }, matched: "/home/seth/.ssh/id_ed25519" }],
      },
      "⛔ Denylist",
    );
    expect(app.frame()).toContain("is on the denylist");
    expect(app.frame()).not.toContain("for this session");
    await app.press(KEY.down, KEY.down, KEY.down);
    expect(app.frame()).toContain("❯ Allow once");
    await app.press(KEY.enter);
    await app.waitUntil(() => answersSent(env).length === 1, "an answer sent");
    expect(answersSent(env)[0]).toEqual({ commandId: expect.any(String), promptId: expect.any(String), sessionId: SESSION, decision: "allow" });
  });
});

describe("the question card", () => {
  const questions: ScriptedPrompt = {
    kind: "question",
    toolName: "AskUserQuestion",
    input: null,
    summary: "Which checks?",
    questions: [
      {
        header: "Checks",
        question: "Which checks?",
        options: [
          { label: "lint", description: "eslint" },
          { label: "types", description: "tsc" },
          { label: "tests", description: "vitest" },
        ],
        multiSelect: true,
      },
      { header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false },
    ],
  };

  it("ticks several options with Space on a multi-select question, then walks to the next, and answers them all", async () => {
    const { app, env } = await opened();
    await park(app, env, questions, "Checks");
    expect(app.frame()).toContain("Which checks?");
    expect(app.frame()).toContain("1/2");
    await app.press(KEY.space, KEY.down, KEY.down, KEY.space);
    expect(app.frame()).toContain("[x] lint");
    expect(app.frame()).toContain("[ ] types");
    expect(app.frame()).toContain("[x] tests");
    await app.press(KEY.enter);
    await app.waitFor("Which database?");
    await app.press(KEY.down, KEY.space);
    expect(app.frame()).toContain("(x) SQLite");
    await app.press(KEY.enter);
    await app.waitUntil(() => answersSent(env).length === 1, "an answer sent");
    expect(answersSent(env)[0]).toMatchObject({ decision: "allow", answers: { "Which checks?": "lint, tests", "Which database?": "SQLite" } });
    await app.waitFor("Which checks? — lint, tests");
  });

  it("skips the question on Esc, which denies it", async () => {
    const { app, env } = await opened();
    await park(app, env, questions, "Checks");
    await app.press(KEY.esc);
    await app.waitUntil(() => answersSent(env).length === 1, "an answer sent");
    expect(answersSent(env)[0]).toEqual({ commandId: expect.any(String), promptId: expect.any(String), sessionId: SESSION, decision: "deny" });
    await app.waitFor("Which checks? — skipped");
  });
});

describe("the plan card", () => {
  const plan = (ceiling: "acceptEdits" | "bypassPermissions"): ScriptedPrompt => ({
    kind: "plan",
    toolName: "ExitPlanMode",
    input: null,
    summary: "Read the parser",
    plan: "1. Read the parser\n2. Fix the off-by-one",
    mode: "plan",
    ceiling,
  });

  it("opens on Keep planning, sends a bare approval with no mode, and a chosen mode with the approval that names it", async () => {
    const { app, env } = await opened();
    await park(app, env, plan("bypassPermissions"), "▤ Plan to approve");
    expect(app.frame()).toContain("2. Fix the off-by-one");
    expect(app.frame()).toContain("❯ Keep planning");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Plan — approved, continuing in acceptEdits");

    await park(app, env, plan("bypassPermissions"), "▤ Plan to approve");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Plan — approved, continuing in auto");
    const sent = answersSent(env);
    expect(sent[0]).toEqual({ commandId: expect.any(String), promptId: expect.any(String), sessionId: SESSION, decision: "allow" });
    expect(sent[1]).toMatchObject({ decision: "allow", mode: "auto" });
  });

  it("greys a mode above the ceiling the run was resolved under, and sends nothing for it", async () => {
    const { app, env } = await opened();
    await park(app, env, plan("acceptEdits"), "▤ Plan to approve");
    expect(app.frame()).toContain("above the ceiling acceptEdits");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("auto is above the ceiling acceptEdits");
    expect(answersSent(env)).toEqual([]);
    await app.press(KEY.enter);
    expect(answersSent(env)).toEqual([]);
    await app.press(KEY.up, KEY.up, KEY.enter);
    await app.waitFor("Plan — kept planning");
  });
});

describe("answering", () => {
  it("closes the card when another client answers first", async () => {
    const { app, env } = await opened();
    const promptId = await park(app, env);
    env.answerElsewhere(SESSION, promptId, { decision: "allow" });
    await app.waitFor("Bash: rm -rf build — allowed");
    expect(app.frame()).not.toContain("⚿ Permission");
    expect(answersSent(env)).toEqual([]);
  });

  it("says a late answer's conflict in one notice line", async () => {
    const { app, env } = await opened();
    const promptId = await park(app, env);
    const elsewhere = env.answerElsewhere(SESSION, promptId, { heard: false });
    await app.press(KEY.enter);
    await app.waitFor("Answer on Receipts was rejected: already answered.");
    elsewhere.hear();
    await app.waitFor("Bash: rm -rf build — allowed");
    expect(app.frame().split("already answered").length - 1).toBe(1);
    expect(env.answered()).toHaveLength(1);
  });

  it("refuses at once with one line while the environment cannot be reached, and queues nothing", async () => {
    const { app, env } = await opened();
    await park(app, env);
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("Locked: desk cannot be reached.");
    await app.press(KEY.enter);
    await app.waitFor("Not answered: desk cannot be reached.");
    expect(app.frame()).toContain("⚿ Permission");
    env.discovery("ready");
    env.autoAccept(true);
    await app.jump(40_000);
    await app.waitFor("message the agent", 400).catch(() => undefined);
    expect(answersSent(env)).toEqual([]);
    expect(env.answered()).toEqual([]);
  });

  it("sends an answer given as the socket drops again with its command id, and it applies once", async () => {
    const { app, env } = await opened();
    await park(app, env);
    env.holdAnswers(true);
    await app.press(KEY.enter);
    await app.waitUntil(() => answersSent(env).length === 1, "an answer sent");
    const [first] = answersSent(env);
    env.holdAnswers(false);
    env.server.drop();
    await app.waitUntil(() => answersSent(env).length === 1 && env.wire.opened() > 1, "the answer sent again on a new socket", 400);
    expect(answersSent(env)[0]?.["commandId"]).toBe(first?.["commandId"]);
    await app.waitFor("Bash: rm -rf build — denied");
    expect(env.answered()).toHaveLength(1);
    expect(app.frame()).not.toContain("⚿ Permission");
  });
});
