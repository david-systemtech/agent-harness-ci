import { act, screen, waitFor, within } from "@testing-library/react";
import { ENVIRONMENT_ICONS, type AccountUsage, type EnvironmentIcon } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";
import { glyphOf } from "./connections/environment-glyphs.js";

/**
 * The status line under a session's composer (docs/specs/gui.md, "A session
 * pane"; story 12; #402): what the next run goes out as (the environment's
 * badge, the account's label and identity, model and effort, the mode badge
 * with its clamp, containment as set or the default marked so), the plan
 * gauge pooled by account identity, and what the run is doing, or the
 * hand-off offer while the account's window is out and no run is live.
 * Driven through the harness over the scripted environment's accounts,
 * models, usage readings and runs.
 */

const WORK = { provider: "claude", email: "milo@work.test", organisation: null };
const HOME = { provider: "claude", email: "milo@home.test", organisation: null };

/** The session's environment: two accounts, the session on the first, the containment default `workspace`. */
const desk = (more: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  accounts: [
    { id: "account-1", label: "work", identity: WORK },
    { id: "account-2", label: "personal", identity: HOME },
  ],
  sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4", mode: "auto" }],
  settings: { "permissions.containment.default": "workspace" },
  ...more,
});

/** The window over `environments`, the first one's first session opened in the pane. */
const opened = async (environments: readonly ScriptedEnvironment[] = [desk()]) => {
  const app = await renderApp({ environments });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, session: env.sessionId(), transcript };
};

/** The status line. */
const statusLine = () => screen.getByRole("region", { name: "Status line" });

/** The status line's text, its pieces run together. */
const lineText = () => statusLine().textContent ?? "";

const reading = (accountId: string, identity: AccountUsage["identity"], windows: AccountUsage["windows"]): AccountUsage => ({
  accountId,
  identity,
  windows,
  readAt: "2026-09-25T09:00:00.000Z",
  unavailableReason: null,
});
const window = (name: string, utilisation: number, observedAt: string, verdict: "rejected" | null = null) => ({
  window: name,
  utilisation,
  resetsAt: "2026-09-25T14:30:00.000Z",
  verdict,
  observedAt,
});

describe("the status line", () => {
  it("shows the environment's badge, the account's label and identity, model and effort, the mode badge and the containment default marked so", async () => {
    const { env, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts", [], { model: "claude-opus-4", effort: "high" });
    env.endRun(session, runId);
    const line = await screen.findByRole("region", { name: "Status line" });
    expect(await within(line).findByRole("button", { name: "Account: work milo@work.test" })).toBeTruthy();
    expect(within(line).getByText("desk")).toBeTruthy();
    expect(within(line).getByRole("button", { name: "Model: claude-opus-4 high" }).textContent).toBe("claude-opus-4 high");
    expect(within(line).getByRole("button", { name: "Mode: ⏸ auto" }).textContent).toBe("⏸ auto");
    expect(await within(line).findByRole("button", { name: "Containment: ◐ workspace (default)" })).toBeTruthy();
  });

  it("draws the environment's icon as a glyph of its own for each of the ten, named by the icon, in its colour's token, as the environment names each in turn", async () => {
    const { env } = await opened([desk({ icon: "laptop", colour: "teal" })]);
    const drawings = new Set<string>();
    for (const icon of ENVIRONMENT_ICONS) {
      act(() => env.setLook({ icon }));
      const glyph = await within(statusLine()).findByRole("img", { name: icon });
      expect(glyph.tagName).toBe("svg");
      expect(glyph.style.color).toBe("var(--environment-teal)");
      expect(glyph.nextElementSibling?.textContent).toBe("desk");
      drawings.add(glyph.innerHTML);
    }
    expect(drawings.size).toBe(ENVIRONMENT_ICONS.length);
    // Drawn, never written: the line does not read "laptop desk".
    expect(lineText()).not.toMatch(new RegExp(ENVIRONMENT_ICONS.join("|")));
  });

  it("draws a dot in the colour's token for an icon this window does not know (a newer environment's), as for an environment from before icons", async () => {
    await opened([desk({ hello: { environmentIcon: "phone" as EnvironmentIcon, environmentColour: "teal" } })]);
    const line = await screen.findByRole("region", { name: "Status line" });
    const dot = within(line).getByText("desk").previousElementSibling as HTMLElement;
    expect(dot.tagName).toBe("SPAN");
    expect(dot.style.color).toBe("var(--environment-teal)");
    expect(within(line).queryByRole("img", { name: "phone" })).toBeNull();
    expect(lineText()).not.toContain("phone");
    // The runtime reads the name as none; the window's lookup takes only the ten too, whatever reaches it.
    for (const name of ["phone", "constructor", ""]) expect(glyphOf(name)).toBeUndefined();
  });

  it("says what a session with no run yet goes out as: the default account and model", async () => {
    await opened([desk({ sessions: [{ title: "Receipts" }] })]);
    const line = await screen.findByRole("region", { name: "Status line" });
    expect(within(line).getByRole("button", { name: "Account: default account" })).toBeTruthy();
    expect(within(line).getByRole("button", { name: "Model: default model" })).toBeTruthy();
    expect(within(line).getByRole("button", { name: "Mode: ⏵⏵ accept edits" })).toBeTruthy();
  });

  it("shows the clamp of a session's mode above this connection's ceiling", async () => {
    await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "bypassPermissions" }], hello: { ceiling: "auto" } })]);
    const line = await screen.findByRole("region", { name: "Status line" });
    expect(within(line).getByRole("button", { name: "Mode: ⏸ auto (clamped from bypassPermissions)" }).textContent).toBe("⏸ auto (clamped from bypassPermissions)");
  });

  it("shows the session's own containment level once it is set, unmarked", async () => {
    const { env, session } = await opened();
    await waitFor(() => expect(lineText()).toContain("◐ workspace (default)"));
    env.emit(session, "session.containment.set", { containment: { requested: "workspace-no-network", effective: "workspace-no-network", clamped: false } });
    expect(await within(statusLine()).findByRole("button", { name: "Containment: ● no network" })).toBeTruthy();
  });
});

describe("the plan gauge", () => {
  it("pools the session's account identity across two environments, each window from the reading that observed it last", async () => {
    const { app, env } = await opened([desk(), { name: "laptop", reach: "paired", accounts: [{ id: "account-9", label: "work", identity: WORK }] }]);
    env.setUsage([reading("account-1", WORK, [window("five_hour", 0.42, "2026-09-25T09:00:00.000Z")])]);
    app.environment("laptop").setUsage([reading("account-9", WORK, [window("five_hour", 0.61, "2026-09-25T09:05:00.000Z"), window("seven_day", 0.12, "2026-09-25T09:05:00.000Z")])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    await waitFor(() => expect(gauge.textContent).toBe("5hr 61%Week 12%"));
  });

  it("marks a window the provider refuses as out", async () => {
    const { env } = await opened();
    env.setUsage([reading("account-1", WORK, [window("five_hour", 1, "2026-09-25T09:00:00.000Z", "rejected")])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    await waitFor(() => expect(gauge.textContent).toBe("5hr 100% out"));
  });
});

describe("the run", () => {
  it("keeps spend in status and activity with elapsed time above the composer", async () => {
    const { app, env, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "pnpm test" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "usage.reported", {
      runId,
      models: [{ model: "claude-opus-4", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.042, contextWindow: null }],
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "Run activity" }).textContent).toContain("Running a command"));
    act(() => app.clock.advance(64_000));
    await waitFor(() => expect(screen.getByRole("status", { name: "Run activity" }).textContent).toContain("1m 04s"));
    expect(lineText()).toContain("3.5k tok · $0.042");
    expect(lineText()).not.toContain("Running a command");

    env.endRun(session, runId, {
      usage: [{ model: "claude-opus-4", inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }],
    });
    await waitFor(() => expect(lineText()).toContain("4.0k tok · $0.050"));
  });

  it("says a run parked on a prompt waits for you", async () => {
    const { env, session } = await opened();
    env.startRun(session, "Fix the receipts");
    env.openPrompt(session, {});
    await waitFor(() => expect(screen.getByRole("status", { name: "Run activity" }).textContent).toContain("waiting for you"));
  });
});

describe("run info", () => {
  it("shows the latest run's resolved policy, account, model, effort, tokens, cost and ending on Mod+I, and hides it on Mod+I again", async () => {
    const { app, env, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts", [], { model: "claude-opus-4", effort: "high" });
    env.emit(session, "run.policy.resolved", {
      runId,
      actorKind: "client",
      actorName: null,
      attended: true,
      mode: { requested: "bypassPermissions", effective: "auto", ceiling: "auto", clamped: true, clampReason: "ceiling" },
      containment: { requested: null, effective: "workspace", mechanism: "bubblewrap", reason: null },
      unattendedDefaultApplied: false,
    });
    env.endRun(session, runId, {
      reason: "error",
      usage: [{ model: "claude-opus-4", inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }],
    });
    await waitFor(() => expect(lineText()).toContain("4.0k tok"));

    await app.user.keyboard("{Control>}i{/Control}");
    const info = await screen.findByRole("region", { name: "The latest run" });
    const fact = (term: string) => within(info).getByText(term).nextElementSibling?.textContent;
    expect(fact("Started by")).toBe("client, attended");
    await waitFor(() => expect(fact("Account")).toBe("work (milo@work.test)"));
    expect(fact("Model")).toBe("claude-opus-4");
    expect(fact("Effort")).toBe("high");
    expect(fact("Mode")).toBe("auto, clamped from bypassPermissions to the ceiling auto");
    expect(fact("Containment")).toBe("workspace (the environment's default), enforced by bubblewrap");
    expect(fact("Tokens")).toBe("4.0k (1.5k in, 2.0k cache read, 0 cache write, 500 out)");
    expect(fact("Cost")).toBe("$0.050");
    expect(fact("Ending")).toBe("Error: The run failed.");

    await app.user.keyboard("{Control>}i{/Control}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "The latest run" })).toBeNull());
  });

  it("says there is no run yet, and closes on Esc", async () => {
    const { app } = await opened();
    await app.user.click(within(screen.getByRole("region", { name: "Session pane" })).getByRole("button", { name: "Run info" }));
    expect(await screen.findByText("No run yet: the session's first message starts one.")).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("No run yet: the session's first message starts one.")).toBeNull());
  });
});
