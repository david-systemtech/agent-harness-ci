import type { AccountUsage } from "@agent-harness/contracts";
import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The status line (docs/specs/tui.md, "Status, usage, pickers"; #147): line
 * one says what the next message goes out as (the environment's badge, the
 * session's account, model and effort, mode and containment) with the plan
 * windows of its account's identity, pooled across environments, at the
 * right; line two says what the run is doing (activity, elapsed time, tokens,
 * cost, key hints), or offers the hand-off when the account's window is out
 * and no run is live. Shift+Tab steps the mode.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const MILO = { provider: "claude", email: "milo@work.test", organisation: null };

const reading = (accountId: string, windows: AccountUsage["windows"], unavailableReason: string | null = null): AccountUsage => ({
  accountId,
  identity: MILO,
  windows,
  readAt: "2026-09-25T09:00:00.000Z",
  unavailableReason,
});
const window = (name: string, utilisation: number, observedAt: string, verdict: "rejected" | null = null) => ({
  window: name,
  utilisation,
  resetsAt: "2026-09-25T14:30:00.000Z",
  verdict,
  observedAt,
});

/** The session's environment, with its account, and the session opened at launch. */
const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  accounts: [
    { id: "account-1", label: "work", identity: MILO },
    { id: "account-2", label: "personal", identity: { provider: "claude", email: "milo@home.test", organisation: null } },
  ],
  sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4", mode: "auto" }],
  settings: { "permissions.containment.default": "workspace" },
  ...extra,
});

const opened = async (environments: readonly ScriptedEnvironment[] = [desk()]) => {
  const app = await renderApp({ script: { environments }, flags: { session: SESSION } });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

/** The two lines under the composer: the status line. */
const statusLines = (app: RenderedApp): readonly [string, string] => {
  const rows = app.rows();
  return [rows.at(-3) ?? "", rows.at(-2) ?? ""];
};

describe("status line one", () => {
  it("names the environment, the session's account, model and effort, mode and containment, and the plan windows of its identity pooled across environments at the right", async () => {
    const { app, env } = await opened([desk(), { name: "laptop", reach: "paired", accounts: [{ id: "account-9", label: "work", identity: MILO }] }]);
    const { runId } = env.startRun(SESSION, "Fix the receipts", [], { model: "claude-opus-4", effort: "high" });
    env.endRun(SESSION, runId);
    env.setUsage([reading("account-1", [window("five_hour", 0.42, "2026-09-25T09:00:00.000Z")])]);
    app.environment("laptop").setUsage([reading("account-9", [window("five_hour", 0.61, "2026-09-25T09:05:00.000Z"), window("seven_day", 0.12, "2026-09-25T09:05:00.000Z")])]);
    await app.waitFor("5-hour ██░░ 61% · Weekly █░░░ 12%");
    const [one] = statusLines(app);
    expect(one).toMatch(/^DE desk · work · claude-opus-4 high · ⏸ auto · ◐ workspace \(defau…\s+5-hour ██░░ 61% · Weekly █░░░ 12%$/);
  });

  it("says what a session with no run yet goes out as: the default account and model, the default mode, and no plan windows", async () => {
    const { app } = await opened([desk({ sessions: [{ title: "Receipts" }] })]);
    await app.waitFor("default account");
    const [one] = statusLines(app);
    expect(one).toContain("DE desk · default account · default model · ⏵⏵ accept edits · ◐ workspace (default)");
    expect(one).not.toContain("5-hour");
  });

  it("shows the clamp of a session's mode above this connection's ceiling after its badge (#402)", async () => {
    const { app } = await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "bypassPermissions" }], hello: { ceiling: "auto" } })]);
    await app.waitFor("⏸ auto (clamped from bypassPermissions)");
    expect(statusLines(app)[0]).toContain("· ⏸ auto (clamped from bypassPermissions) ·");
  });

  it("shows the level another client set on the session once its stream says it, unmarked (#402)", async () => {
    const { app, env } = await opened();
    await app.waitFor("◐ workspace (default)");
    env.emit(SESSION, "session.containment.set", { containment: { requested: "workspace-no-network", effective: "workspace-no-network", clamped: false } });
    await app.waitFor("● no network");
    expect(statusLines(app)[0]).not.toContain("(default)");
  });

  it("shows a containment default another client changed at once, on the settings.changed notice, never waiting on the request cache's five minutes (#391)", async () => {
    const { app, env } = await opened([desk({ sessions: [{ title: "Receipts" }] })]);
    await app.waitFor("◐ workspace (default)");
    const asked = env.requests("permissions.settings.get").length;
    // Another client sets it: the environment says so on its own stream, and the line reads it again.
    env.setSettings({ "permissions.containment.default": "off" });
    await app.waitFor("○ off (default)");
    expect(env.requests("permissions.settings.get").length).toBe(asked + 1);
    expect(statusLines(app)[0]).not.toContain("workspace");
  });

  it("says no session is open, beside the environment's badge, until one is", async () => {
    const app = await renderApp({ script: { environments: [desk()] } });
    apps.push(app);
    await app.waitFor("No session is open.");
    expect(statusLines(app)[0]).toContain("DE desk · no session open");
  });
});

describe("status line two", () => {
  it("says what the live run is doing, for how long, its tokens and cost, and the keys; the last run's spend once it is idle", async () => {
    const { app, env } = await opened();
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "pnpm test" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(SESSION, "usage.reported", {
      runId,
      models: [{ model: "claude-opus-4", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.042, contextWindow: null }],
    });
    await app.jump(64_000);
    await app.waitFor("1m 04s");
    expect(statusLines(app)[1]).toContain("Running a command · 1m 04s · 3.5k tok · $0.042 · Enter queues · Esc interrupts");

    env.endRun(SESSION, runId, {
      usage: [{ model: "claude-opus-4", inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }],
    });
    await app.waitFor(/idle · 4\.0k tok · \$0\.050/);
    expect(statusLines(app)[1]).toContain("idle · 4.0k tok · $0.050 · Enter sends");
  });

  it("says a run parked on a prompt waits for you", async () => {
    const { app, env } = await opened();
    const { runId } = env.startRun(SESSION, "Fix the receipts");
    const prompt = {
      runId,
      promptId: "p1",
      kind: "permission",
      toolName: "Bash",
      toolCallId: null,
      input: null,
      summary: "Bash: rm -rf build",
      blockedPath: null,
      reason: null,
      questions: null,
      plan: null,
      suggestions: [],
      agentId: null,
      denylist: null,
      mode: "acceptEdits",
      ceiling: "bypassPermissions",
      ttlExpiresAt: null,
    };
    env.emit(SESSION, "prompt.opened", prompt, { fields: { activity: { state: "parked", since: new Date(0).toISOString() }, parkedPromptCount: 1 } });
    await app.waitFor("waiting for you");
  });

  it("offers the hand-off in the recommendation's words when the account's window is out and no run is live; Alt+H opens the picker", async () => {
    const out = {
      accountId: "account-2",
      reason: "limit-reached" as const,
      message: "The 5-hour window of work is out until 14:30; personal has the most room (88%).",
      trigger: { threshold: "five_hour", label: "5-hour", at: 0.9, window: "five_hour", utilisation: 1, verdict: "rejected" as const },
      headroom: 0.88,
      binding: "five_hour",
      candidates: 1,
      basis: "same-plan" as const,
    };
    const { app, env } = await opened([desk({ recommendation: out })]);
    await app.waitFor("The 5-hour window of work is out until 14:30; personal has the most room (88%). · Alt+H or /handoff");

    // Not while a run is live: the offer is made only when nothing is running.
    const { runId } = env.startRun(SESSION, "one more thing");
    await app.waitFor("Enter queues");
    expect(app.frame()).not.toContain("Alt+H or /handoff");
    env.endRun(SESSION, runId);
    await app.waitFor("Alt+H or /handoff");

    await app.press("\u001Bh");
    await app.waitFor("Hand off Receipts on desk");
    expect(app.frame()).toContain(out.message);
  });

  it("makes no offer while the account's window has room", async () => {
    const { app, env } = await opened([desk({ recommendation: { accountId: "account-2", reason: "most-room", message: "personal has the most room.", candidates: 1 } })]);
    env.setUsage([reading("account-1", [window("five_hour", 0.2, "2026-09-25T09:00:00.000Z")])]);
    await app.waitFor("5-hour");
    expect(app.frame()).not.toContain("Alt+H or /handoff");
  });
});

describe("Shift+Tab", () => {
  it("steps the session's mode to the next the connection's ceiling allows, wrapping past the ones above it, and shows the mode each answer gives", async () => {
    const { app, env } = await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "acceptEdits" }], hello: { ceiling: "auto" } })]);
    await app.waitFor("⏵⏵ accept edits");
    await app.press(KEY.shiftTab);
    await app.waitFor("Mode: auto.");
    await app.waitFor("⏸ auto");
    expect(env.requests("permissions.mode.set").map((r) => r.params)).toEqual([expect.objectContaining({ sessionId: SESSION, mode: "auto" })]);
    // bypassPermissions is above the ceiling: the step wraps to plan.
    await app.press(KEY.shiftTab);
    await app.waitFor("Mode: plan.");
    await app.waitFor("⏸ plan");
  });

  it("starts the next run in the mode the step gave the session, as the environment does", async () => {
    const { app, env } = await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "acceptEdits" }], hello: { ceiling: "auto" } })]);
    await app.press(KEY.shiftTab);
    await app.press(KEY.shiftTab);
    await app.waitFor("⏸ plan");
    await app.type("look first");
    await app.press(KEY.enter);
    const runs = () => app.runtime().projections.session(env.environmentId, SESSION).read().runs;
    await app.waitUntil(() => runs().length === 1, "the run");
    expect(runs()[0]?.mode).toEqual({ requested: "plan", effective: "plan", clamped: false });
  });

  it("steps on from the mode it asked for while the environment has not answered yet", async () => {
    const { app, env } = await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "acceptEdits" }], hello: { ceiling: "auto" } })]);
    await app.waitFor("⏵⏵ accept edits");
    // Each answer held, then given as the environment gives it: the mode's event, then the accepted receipt.
    const held: (() => void)[] = [];
    env.wire.answer(
      "permissions.mode.set",
      (params) =>
        new Promise<FakeAnswer>((resolve) =>
          held.push(() => {
            const sessionId = String(params["sessionId"]);
            const asked = params["mode"] as "plan" | "acceptEdits" | "auto";
            const mode = { requested: asked, effective: asked, ceiling: "auto", clamped: false, clampReason: null };
            const { sequence } = env.emit(sessionId, "session.mode.set", { mode, live: null }, { fields: { mode: asked } });
            resolve({ result: { receipt: { status: "accepted", sequence, changed: true }, result: { sessionId, mode, live: null } } });
          }),
        ),
    );
    await app.press(KEY.shiftTab);
    await app.press(KEY.shiftTab);
    // Both presses land before the first answer does; the answers are then given as each command reaches the environment.
    for (let answered = 0; answered < 2; answered++) {
      await app.waitUntil(() => held.length === 1, "a step on the wire");
      held.splice(0).forEach((answer) => answer());
    }
    expect(env.requests("permissions.mode.set").map((request) => (request.params as { readonly mode: string }).mode)).toEqual(["auto", "plan"]);
    await app.waitFor("⏸ plan");
  });

  it("shows the bypass sentence when the step lands on bypassPermissions", async () => {
    const { app } = await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "auto" }] })]);
    await app.waitFor("⏸ auto");
    await app.press(KEY.shiftTab);
    await app.waitFor("Mode: bypassPermissions. The agent will act without asking and can do anything this account can, within the containment you chose.");
    await app.waitFor("⏵⏵ BYPASS");
  });

  it("says a mode is a session's when none is open", async () => {
    const app = await renderApp({ script: { environments: [desk()] } });
    apps.push(app);
    await app.waitFor("No session is open.");
    await app.press(KEY.shiftTab);
    await app.waitFor("No session is open: a mode is a session's. /resume opens one, /new starts one.");
  });
});
