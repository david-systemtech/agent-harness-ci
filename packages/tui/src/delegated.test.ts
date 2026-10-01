import type { DelegatedWorkRow } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const task = (taskId: string, description: string, more: Partial<DelegatedWorkRow> = {}): DelegatedWorkRow => ({
  taskId,
  description,
  kind: "local_agent",
  status: "running",
  startedAt: "2026-09-29T10:00:00.000Z",
  endedAt: null,
  subagentType: "Explore",
  toolCallId: `call-${taskId}`,
  error: null,
  ...more,
});

const launch = async (extra: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...extra }] },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  const { runId } = env.startRun(SESSION, "Find the receipts");
  return { app, env, runId };
};

describe("delegated work", () => {
  it("finishes a held transcript read after pager navigation", async () => {
    const { app, env, runId } = await launch({ provider: { subagentTranscripts: true } });
    let release = () => {};
    env.wire.answer("sessions.subagentTranscript", (params) => new Promise((resolve) => {
      release = () => resolve({ result: { sessionId: params["sessionId"], agentId: params["agentId"], messages: [{ type: "assistant", message: { content: "The held read arrived." } }] } });
    }));
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("agent", "Inspect receipts")] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab, KEY.enter);
    await app.waitFor("Reading…");
    await app.press(KEY.down);
    release();
    await app.waitFor("The held read arrived.");
  });

  it("lets Esc close a pending read and keeps its late answer out of the composer", async () => {
    const { app, env, runId } = await launch({ provider: { subagentTranscripts: true } });
    let release = () => {};
    env.wire.answer("sessions.subagentTranscript", (params) => new Promise((resolve) => {
      release = () => resolve({ result: { sessionId: params["sessionId"], agentId: params["agentId"], messages: [{ type: "assistant", message: { content: "A late answer." } }] } });
    }));
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("agent", "Inspect receipts")] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab, KEY.enter);
    await app.waitFor("Reading…");
    await app.press(KEY.esc, KEY.esc);
    release();
    await app.type("continue here");
    await app.waitFor("› continue here");
    expect(app.frame()).not.toContain("A late answer.");
    expect(env.requests("runs.interrupt")).toHaveLength(0);
  });

  it("says when an agent has no stored transcript yet", async () => {
    const { app, env, runId } = await launch({ provider: { subagentTranscripts: true } });
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("agent", "Inspect receipts")] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab, KEY.enter);
    await app.waitFor("Nothing is stored for this agent yet.");
    await app.press("q");
    await app.waitFor("The delegated strip has the keys");
  });

  it("says a stop refusal on one line", async () => {
    const { app, env, runId } = await launch({ receipts: { "runs.stopTask": { rejected: "conflict", message: "The adapter\ncannot stop this task." } } });
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("agent", "Inspect receipts")] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab, "x");
    await app.waitFor("Not stopped: The adapter cannot stop this task.");
    expect(app.frame()).toContain("The delegated strip has the keys");
  });

  it("says when the adapter cannot read subagent transcripts", async () => {
    const { app, env, runId } = await launch();
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("agent", "Inspect receipts")] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab, KEY.enter);
    await app.waitFor("Not read: The Claude adapter cannot read a subagent's transcript: it does not declare subagentTranscripts.");
    expect(app.frame()).toContain("The delegated strip has the keys");
  });

  it("opens no transcript for a shell task", async () => {
    const { app, env, runId } = await launch({ provider: { subagentTranscripts: true } });
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("shell", "Run checks", { kind: "local_bash", subagentType: null })] });
    await app.waitFor("Run checks");
    await app.press(KEY.tab, KEY.tab, KEY.enter);
    await app.waitFor("That task is not an agent: it has no transcript to read.");
    expect(env.requests("sessions.subagentTranscript")).toHaveLength(0);
  });

  it("keeps the selected task as new work arrives and returns to the composer when the strip drains", async () => {
    const { app, env, runId } = await launch();
    const selected = task("selected", "Inspect receipts");
    env.emit(SESSION, "tasks.changed", { runId, tasks: [selected] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab);
    await app.waitFor("› ⤷ Explore: Inspect receipts");
    env.emit(SESSION, "tasks.changed", { runId, tasks: [selected, task("new", "Check totals", { startedAt: "2026-09-29T10:02:00.000Z" })] });
    await app.waitFor("Check totals");
    expect(app.frame()).toContain("› ⤷ Explore: Inspect receipts");
    env.emit(SESSION, "tasks.changed", { runId, tasks: [] });
    await app.waitUntil(() => !app.frame().includes("The delegated strip has the keys"), "the strip to drain");
    await app.type("carry on");
    await app.waitFor("› carry on");
  });

  it("Enter reads the selected agent's stored messages as transcript rows in the pager", async () => {
    const { app, env, runId } = await launch({
      provider: { subagentTranscripts: true },
      subagentTranscripts: {
        "call-agent": [
          { type: "user", uuid: "prompt", message: { content: "Inspect receipts" } },
          { type: "assistant", uuid: "reply", message: { content: [
            { type: "thinking", thinking: "Check the totals first" },
            { type: "tool_use", id: "read", name: "Read", input: { file_path: "receipts.ts" } },
          ] } },
          { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "Totals match" }] } },
          { type: "assistant", uuid: "answer", message: { content: "The receipts are correct." } },
        ],
      },
    });
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("agent", "Inspect receipts")] });
    await app.waitFor("Inspect receipts");
    await app.press(KEY.tab, KEY.tab, KEY.enter);
    await app.waitFor("The receipts are correct.");
    expect(env.requests("sessions.subagentTranscript")[0]?.params).toEqual({ sessionId: SESSION, agentId: "call-agent" });
    expect(app.frame()).toContain("▌ Inspect receipts");
    expect(app.frame()).toContain("Check the totals first");
    expect(app.frame()).toContain("Read(receipts.ts)");
    expect(app.frame()).toContain("Totals match");
    await app.press(KEY.esc);
    await app.waitFor("The delegated strip has the keys");
    expect(app.frame()).not.toContain("The receipts are correct.");
    await app.press(KEY.esc);
    await app.type("continue");
    await app.waitFor("› continue");
  });

  it("x stops the selected task without interrupting the run", async () => {
    const { app, env, runId } = await launch();
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("one", "Check receipts"), task("two", "Find parser")] });
    await app.waitFor("Find parser");
    await app.press(KEY.tab, KEY.tab, KEY.down, "x");
    await app.waitUntil(() => env.requests("runs.stopTask").length === 1, "the selected task to stop");
    expect(env.requests("runs.stopTask")[0]?.params).toMatchObject({ runId, taskId: "one" });
    expect(env.requests("runs.interrupt")).toHaveLength(0);
  });

  it("Tab reaches the live strip, arrows select tasks, and Esc returns to the composer", async () => {
    const { app, env, runId } = await launch();
    env.emit(SESSION, "tasks.changed", { runId, tasks: [task("older", "Check receipts"), task("newer", "Find parser", { startedAt: "2026-09-29T10:01:00.000Z" })] });
    await app.waitFor("Find parser");
    await app.press(KEY.tab, KEY.tab);
    await app.waitFor("The delegated strip has the keys");
    expect(app.frame()).toContain("› ⤷ Explore: Find parser");
    await app.press(KEY.down);
    await app.waitFor("› ⤷ Explore: Check receipts");
    await app.press(KEY.up);
    await app.waitFor("› ⤷ Explore: Find parser");
    await app.press(KEY.esc);
    await app.type("keep typing");
    await app.waitFor("› keep typing");
    expect(env.requests("runs.interrupt")).toHaveLength(0);
  });
});
