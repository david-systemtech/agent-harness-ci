import { afterEach, describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp } from "../test/harness.js";

/**
 * The transcript (docs/specs/tui.md, "The transcript: a projection of one
 * session"; #146): opened from `--session`, streamed from
 * `projections.session` as the scripted environment appends events,
 * bottom-anchored, folded as Artemis folds a run's calls, a quiet call
 * turning amber, prompts and plans in place, the cost line under a finished
 * turn, an unknown event as one dim row, and the freshness marker until the
 * stream is live.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";

/** The local environment with one session, opened at launch with `--session`. */
const opened = async (extra: Partial<Parameters<typeof renderApp>[0]> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } }] }] },
    flags: { session: SESSION },
    ...extra,
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const run = (env: EnvironmentHandle, text = "Fix the receipts") => env.startRun(SESSION, text);

describe("streaming", () => {
  it("opens the session named by --session and draws its text as the deltas arrive, anchored to the bottom", async () => {
    const { app, env } = await opened();
    const { runId } = run(env);
    await app.waitFor("Fix the receipts");
    env.emit(SESSION, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await app.waitFor("● Looking at");
    env.emit(SESSION, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "the parser." }] });
    await app.waitFor("● Looking at the parser.");
    // Bottom-anchored: the last line of the transcript sits just above the lines under it, not at the top of the screen.
    const rows = app.rows();
    const at = rows.findIndex((row) => row.includes("● Looking at the parser."));
    const composer = rows.findIndex((row) => row.startsWith("› ") || row.startsWith("✕ "));
    expect(at).toBeGreaterThan(10);
    expect(composer - at).toBeLessThanOrEqual(4);
    env.emit(SESSION, "assistant.text", { runId, itemId: "i-1", text: "Looking at the parser. Found it.", aborted: false });
    await app.waitFor("● Looking at the parser. Found it.");
  });

  it("heads the transcript with the freshness marker until the stream is live", async () => {
    const app = await renderApp({
      script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], autoAccept: true }] },
      flags: { session: SESSION },
    });
    apps.push(app);
    await app.waitFor("Nothing said yet.");
    expect(app.frame()).not.toContain("catching up");
    expect(app.frame()).not.toContain("cached");
    // The environment goes away: what this terminal holds is shown as cached until it is back and synchronized.
    app.environment("desk").server.drop();
    await app.waitFor("◌ cached: what this terminal last saw of it");
    expect(app.frame()).toContain("Locked: desk cannot be reached.");
  });

  it("draws an event of a type this version does not know as one dim row naming its type", async () => {
    const { app, env } = await opened();
    env.emit(SESSION, "weird.new-thing", { anything: true });
    await app.waitFor("· weird.new-thing: an event this version does not show");
  });
});

describe("the fold", () => {
  it("folds a run's finished calls into one count, running and failed calls in full", async () => {
    const { app, env } = await opened();
    const { runId } = run(env);
    const call = (toolCallId: string, name: string, input: Record<string, unknown>) =>
      env.emit(SESSION, "tool.started", { runId, toolCallId, name, input, title: null, agentId: null, parentToolCallId: null });
    const ended = (toolCallId: string, status: "ok" | "error", output: unknown) => env.emit(SESSION, "tool.ended", { runId, toolCallId, status, output, durationMs: 20 });
    call("t1", "Bash", { command: "ls" });
    ended("t1", "ok", "a\nb");
    call("t2", "Read", { file_path: "src/parser.ts" });
    ended("t2", "ok", "…");
    call("t3", "Bash", { command: "pnpm test" });
    ended("t3", "error", "FAIL src/parser.test.ts\nexpected 2, got 3");
    call("t4", "Bash", { command: "pnpm build" });
    await app.waitFor("Bash(pnpm build)");
    const frame = app.frame();
    expect(frame).toContain("◆ Ran a command, read a file");
    expect(frame).not.toContain("Bash(ls)");
    expect(frame).not.toContain("Read(src/parser.ts)");
    expect(frame).toContain("Bash(pnpm test)");
    expect(frame).toContain("expected 2, got 3");
    expect(frame).toContain("Bash(pnpm build)");
  });

  it("turns a call quiet for three minutes amber, naming the silence and the key that stops it", async () => {
    const { app, env } = await opened();
    const { runId } = run(env);
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "pnpm test" }, title: null, agentId: null, parentToolCallId: null });
    await app.waitFor("Bash(pnpm test)");
    await app.jump(2 * 60_000);
    expect(app.frame()).not.toContain("no output for");
    // A progress report is the call saying something: the silence counts from it.
    env.emit(SESSION, "tool.updated", { runId, toolCallId: "t1", update: { progress: "half" } });
    await app.waitFor("half");
    await app.jump(2 * 60_000);
    expect(app.frame()).not.toContain("no output for");
    await app.jump(60_000 + 1000);
    await app.waitFor("no output for 3m · x stops it");
    await app.jump(60_000);
    await app.waitFor("no output for 4m · x stops it");
  });

  it("puts the cost line under a finished turn: its time, its tokens, its dollars", async () => {
    const { app, env } = await opened();
    const { runId } = run(env);
    env.emit(SESSION, "assistant.text", { runId, itemId: "i-1", text: "Done.", aborted: false });
    env.endRun(SESSION, runId, {
      durationMs: 4200,
      usage: [{ model: "claude-fake", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 0.042, contextWindow: null }],
    });
    await app.waitFor("4.2s · 2.0k in · 340 out · $0.042");
    const rows = app.rows();
    expect(rows.findIndex((row) => row.includes("4.2s · 2.0k in"))).toBeGreaterThan(rows.findIndex((row) => row.includes("● Done.")));
  });

  it("says how a turn that did not complete ended", async () => {
    const { app, env } = await opened();
    const { runId } = run(env);
    env.endRun(SESSION, runId, { reason: "interrupted", durationMs: 900 });
    await app.waitFor("✗ Interrupted · 900ms");
  });
});

describe("prompts and plans", () => {
  const prompt = (runId: string, promptId: string, kind: "permission" | "question" | "plan", more: Record<string, unknown> = {}) => ({
    runId,
    promptId,
    kind,
    toolName: kind === "permission" ? "Bash" : null,
    toolCallId: null,
    input: null,
    summary: kind === "permission" ? "Bash: rm -rf build" : kind === "plan" ? "A plan to approve" : "Which database?",
    blockedPath: null,
    reason: null,
    questions: kind === "question" ? [{ header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "" }], multiSelect: false }] : null,
    plan: kind === "plan" ? "1. Read the parser\n2. Fix the off-by-one" : null,
    suggestions: [],
    agentId: null,
    mode: "acceptEdits",
    ceiling: "bypassPermissions",
    ttlExpiresAt: null,
    ...more,
  });
  const answer = (runId: string, promptId: string, more: Record<string, unknown> = {}) => ({
    runId,
    promptId,
    decision: "allow",
    message: null,
    answers: null,
    updatedInput: null,
    mode: null,
    remember: null,
    decidedBy: "0199cc00-0000-7000-8000-000000000009",
    delivery: "live",
    ...more,
  });

  it("draws an answered prompt and question at the place they were asked, and a plan's text in place", async () => {
    const { app, env } = await opened();
    const { runId } = run(env);
    env.emit(SESSION, "assistant.text", { runId, itemId: "i-1", text: "First.", aborted: false });
    env.emit(SESSION, "prompt.opened", prompt(runId, "p-1", "permission"), { fields: { parkedPromptCount: 1 } });
    env.emit(SESSION, "assistant.text", { runId, itemId: "i-2", text: "Second.", aborted: false });
    env.emit(SESSION, "prompt.opened", prompt(runId, "p-2", "question"));
    env.emit(SESSION, "prompt.opened", prompt(runId, "p-3", "plan"));
    await app.waitFor("Bash: rm -rf build — waiting for an answer");
    env.emit(SESSION, "prompt.answered", answer(runId, "p-1", { remember: "session" }), { fields: { parkedPromptCount: 0 } });
    env.emit(SESSION, "prompt.answered", answer(runId, "p-2", { answers: { "Which database?": "Postgres" } }));
    env.emit(SESSION, "prompt.answered", answer(runId, "p-3", { mode: { requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null } }));
    await app.waitFor("Bash: rm -rf build — allowed for this session");
    const rows = app.rows();
    const where = (text: string) => rows.findIndex((row) => row.includes(text));
    expect(where("● First.")).toBeLessThan(where("Bash: rm -rf build"));
    expect(where("Bash: rm -rf build")).toBeLessThan(where("● Second."));
    expect(app.frame()).toContain("Which database? — Postgres");
    expect(app.frame()).toContain("Plan — approved, continuing in acceptEdits");
    expect(app.frame()).toContain("2. Fix the off-by-one");
  });
});
