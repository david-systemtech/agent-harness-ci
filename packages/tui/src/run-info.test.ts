import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const launch = async () => {
  const app = await renderApp({
    script: { environments: [{
      name: "desk", reach: "local",
      accounts: [{ id: "account-1", label: "work", identity: { provider: "claude", email: "milo@work.test", organisation: null } }],
      sessions: [{ id: SESSION, title: "Receipts", accountId: "account-1", mode: "auto" }],
    }] },
    flags: { session: SESSION },
    size: { columns: 160, rows: 36 },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

describe("run info", () => {
  it("shows the latest run's resolved clamp, containment, actor, account, model, effort, usage and ending on Alt+I, and toggles closed", async () => {
    const { app, env } = await launch();
    const older = env.startRun(SESSION, "An earlier run", [], { model: "older-model" });
    env.endRun(SESSION, older.runId);
    const { runId } = env.startRun(SESSION, "Fix the receipts", [], { model: "claude-opus-4", effort: "high" });
    env.emit(SESSION, "run.policy.resolved", {
      runId, actorKind: "client", actorName: null, attended: true,
      mode: { requested: "bypassPermissions", effective: "auto", ceiling: "auto", clamped: true, clampReason: "ceiling" },
      containment: { requested: "workspace-no-network", effective: "workspace", mechanism: "bubblewrap", reason: "Network containment unavailable" },
      unattendedDefaultApplied: false,
    });
    env.endRun(SESSION, runId, {
      reason: "error",
      usage: [{ model: "claude-opus-4", inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }],
    });
    await app.press("\u001Bi");
    await app.waitFor("The latest run");
    for (const fact of [
      "Started by: client, attended", "Account: work (milo@work.test)",
      "Model: claude-opus-4", "Effort: High",
      "Mode: auto, clamped from bypassPermissions to the ceiling auto",
      "Containment: workspace (asked for workspace-no-network), enforced by bubblewrap: Network containment unavailable",
      "Tokens: 4.0k (1.5k in, 2.0k cache read, 0 cache write, 500 out)",
      "Cost: $0.050", "Ending: Error: The run failed.",
    ]) expect(app.frame()).toContain(fact);
    await app.press("\u001Bi");
    expect(app.frame()).not.toContain("The latest run");
    expect(env.requests("runs.start")).toHaveLength(0);
  });
  it("wraps the no-run explanation on a narrow terminal and closes with Esc", async () => {
    const { app } = await launch();
    await app.resize({ columns: 40, rows: 20 });
    await app.press("\u001Bi");
    await app.waitFor("No run yet:");
    expect(app.frame().replace(/\s+/g, " ")).toContain("No run yet: the session's first message starts one.");
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain("The latest run");
  });

  it("marks an unheard policy, follows policy and usage arriving live, and follows the next run while open", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    await app.press("\u001Bi");
    await app.waitFor("Containment: not heard by this client:");
    expect(app.frame()).toContain("the run's policy was resolved before it caught up");
    expect(app.frame()).toContain("Effort: the model's own");
    expect(app.frame()).toContain("Tokens: none reported yet");
    expect(app.frame()).toContain("Cost: not reported");
    expect(app.frame()).toContain("Ending: still running");

    env.emit(SESSION, "run.policy.resolved", {
      runId, actorKind: "routine", actorName: "Receipts", attended: false,
      mode: { requested: "auto", effective: "acceptEdits", ceiling: "bypassPermissions", clamped: true, clampReason: "unavailable" },
      containment: { requested: null, effective: "off", mechanism: null, reason: null },
      unattendedDefaultApplied: true,
    });
    env.emit(SESSION, "usage.reported", {
      runId, models: [{ model: "claude-opus-4", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 10, costUsd: null, contextWindow: null }],
    });
    await app.waitFor("Started by: routine Receipts, unattended (the unattended default mode)");
    expect(app.frame()).toContain("Mode: acceptEdits, clamped from auto: its account cannot use it");
    expect(app.frame()).toContain("Containment: off (the environment's default)");
    expect(app.frame()).toContain("Tokens: 130 (100 in, 0 cache read, 10 cache write, 20 out)");
    expect(app.frame()).not.toContain("not heard");

    env.endRun(SESSION, runId);
    env.startRun(SESSION, "The next run", [], { model: "next-model" });
    await app.waitFor("Model: next-model");
    expect(app.frame()).toContain("not heard by this client");
    expect(app.frame()).not.toContain("routine Receipts");
    expect(app.frame()).toContain("Ending: still running");
    await app.press("q");
    expect(app.frame()).not.toContain("The latest run");
  });

  it("scrolls wrapped facts on a small screen and keeps a new shorter run visible after scrolling to the end", async () => {
    const { app, env } = await launch();
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.emit(SESSION, "run.policy.resolved", {
      runId, actorKind: "client", actorName: null, attended: true,
      mode: { requested: "bypassPermissions", effective: "auto", ceiling: "auto", clamped: true, clampReason: "ceiling" },
      containment: { requested: "workspace-no-network", effective: "workspace", mechanism: "bubblewrap", reason: "The environment cannot enforce network containment. ".repeat(15) },
      unattendedDefaultApplied: false,
    });
    await app.resize({ columns: 40, rows: 20 });
    await app.press("\u001Bi");
    await app.waitFor("Started by: client, attended");
    expect(app.frame()).not.toContain("Ending: still running");
    await app.press("G");
    await app.waitFor("Ending: still running");
    env.endRun(SESSION, runId);
    const next = env.startRun(SESSION, "The next run", [], { model: "next-model" });
    env.endRun(SESSION, next.runId, { reason: "error" });
    await app.waitFor("Ending: Error: The run failed.");
    await app.press("g");
    await app.waitFor("Model: next-model");
  });

});
