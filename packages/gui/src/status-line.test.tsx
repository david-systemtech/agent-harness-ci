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
  it("keeps named icon chips in one wrapping row, with containment before browser and no text icons", async () => {
    await opened();
    const line = statusLine();
    const chips = within(line).getAllByRole("button").filter((button) => /^(Account|Model|Mode|Containment|Browser):/.test(button.getAttribute("aria-label") ?? ""));
    expect(chips.map((button) => button.getAttribute("aria-label")?.split(":")[0])).toEqual(["Account", "Model", "Mode", "Containment", "Browser"]);
    for (const chip of chips) {
      expect(chip.querySelector("svg")).not.toBeNull();
      expect(chip.className).toContain("h-[22px]");
      expect(chip.className).toContain("max-w-[240px]");
    }
    expect(line.textContent).not.toMatch(/[⏸⏵◐●○]/);
    expect(line.children).toHaveLength(2); // choices and nonshrinking meters, no second status row
  });

  it("shows the environment's badge, the account's label and identity, model and effort, the mode badge and the containment default marked so", async () => {
    const { env, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts", [], { model: "claude-opus-4", effort: "high" });
    env.endRun(session, runId);
    const line = await screen.findByRole("region", { name: "Status line" });
    expect(await within(line).findByRole("button", { name: "Account: work milo@work.test" })).toBeTruthy();
    expect(within(line).getByText("desk")).toBeTruthy();
    expect(within(line).getByRole("button", { name: "Model: claude-opus-4 high" }).textContent).toBe("claude-opus-4 high");
    expect(within(line).getByRole("button", { name: "Mode: auto" }).textContent).toBe("auto");
    expect(await within(line).findByRole("button", { name: "Containment: workspace (default)" })).toBeTruthy();
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
    expect(within(line).getByRole("button", { name: "Mode: accept edits" })).toBeTruthy();
    expect(within(line).queryByText("idle")).toBeNull();
  });

  it("keeps an unavailable stored model visible in amber and explains it in its tooltip", async () => {
    const { app } = await opened([desk({ models: [{ accountId: "account-1", models: [{ id: "available-model", family: "sonnet", tier: 1, label: null, efforts: [] }] }] })]);
    const model = within(statusLine()).getByRole("button", { name: "Model: claude-opus-4" });
    await waitFor(() => expect(model.textContent).toBe("claude-opus-4"));
    act(() => model.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("not listed for this account");
    expect(model.querySelector(".text-amber")).not.toBeNull();
    await app.user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "available-model" })).toBeTruthy();
  });

  it("shows the clamp of a session's mode above this connection's ceiling", async () => {
    await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", mode: "bypassPermissions" }], hello: { ceiling: "auto" } })]);
    const line = await screen.findByRole("region", { name: "Status line" });
    expect(within(line).getByRole("button", { name: "Mode: auto (clamped from bypassPermissions)" }).textContent).toBe("auto (clamped from bypassPermissions)");
  });

  it("shows the session's own containment level once it is set, unmarked", async () => {
    const { env, session } = await opened();
    await waitFor(() => expect(lineText()).toContain("workspace (default)"));
    env.emit(session, "session.containment.set", { containment: { requested: "workspace-no-network", effective: "workspace-no-network", clamped: false } });
    expect(await within(statusLine()).findByRole("button", { name: "Containment: no network" })).toBeTruthy();
  });
});

describe("the plan gauge", () => {
  it("keeps an unknown provider window out of rings and lists it once as Other limit with its share and reset", async () => {
    const { app, env } = await opened();
    env.setUsage([reading("account-1", WORK, [
      window("five_hour", 0.42, "2026-09-25T09:00:00.000Z"),
      window("iguana_necktie", 0.37, "2026-09-25T09:00:00.000Z"),
    ])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    await within(gauge).findByRole("img", { name: /42%/ });
    expect(within(gauge).getAllByRole("img")).toHaveLength(1);
    expect(gauge.outerHTML).not.toMatch(/iguana[_ ]necktie/);
    await app.user.click(within(gauge).getByRole("button", { name: "Usage details" }));
    const details = await screen.findByRole("dialog", { name: "Usage details" });
    const label = within(details).getByText("Other limit");
    expect(within(details).getAllByText("Other limit")).toHaveLength(1);
    const row = label.parentElement?.parentElement as HTMLElement;
    expect(within(row).getByText("37%")).toBeTruthy();
    expect(within(row).getByText("2026-09-25T14:30:00.000Z")).toBeTruthy();
    expect(details.outerHTML).not.toMatch(/iguana[_ ]necktie/);
    expect(within(details).queryByRole("img", { name: /Other limit/ })).toBeNull();
  });

  it("keeps current context separate from pooled plan usage and cumulative spend", async () => {
    const { app, env, session } = await opened();
    const { runId } = env.startRun(session, "Check the receipts", [], { model: "actual-model" });
    env.emit(session, "usage.reported", { runId, models: [
      { model: "actual-model", inputTokens: 2000, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: null, contextWindow: 100000 },
      { model: "other-model", inputTokens: 9000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, contextWindow: 200000 },
    ] });
    await app.user.click(within(statusLine()).getByRole("button", { name: "Usage details" }));
    const details = await screen.findByRole("dialog", { name: "Usage details" });
    expect(await within(details).findByText("Current request context appears in the Context meter when supported.")).toBeTruthy();
    expect(within(statusLine()).queryByRole("img", { name: /^Ctx/ })).toBeNull();
  });

  it("opens cached pooled readings above the meter, refreshes on open and request, and ages them only while open", async () => {
    const { app, env } = await opened();
    env.setUsage([{ ...reading("account-1", WORK, [window("five_hour", 0.8, "2026-09-25T09:00:00.000Z")]), readAt: app.clock.now().toISOString() }]);
    await within(statusLine()).findByRole("img", { name: "5-hour 80%" });
    const before = env.requests("accounts.usage").length;
    await app.user.click(within(statusLine()).getByRole("button", { name: "Usage details" }));
    const details = await screen.findByRole("dialog", { name: "Usage details" });
    expect(within(details).getByText("milo@work.test")).toBeTruthy();
    expect(within(details).getByText("80%")).toBeTruthy();
    expect(within(details).getByText(/2026-09-25T14:30:00/)).toBeTruthy();
    expect(within(details).getByText("Current request context appears in the Context meter when supported.")).toBeTruthy();
    await waitFor(() => expect(env.requests("accounts.usage").length).toBeGreaterThan(before));
    const age = within(details).getByLabelText("Reading age").textContent;
    act(() => app.clock.advance(60_000));
    await waitFor(() => expect(within(details).getByLabelText("Reading age").textContent).not.toBe(age));
    const refreshed = env.requests("accounts.usage").length;
    await app.user.click(within(details).getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(env.requests("accounts.usage").length).toBeGreaterThan(refreshed));
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Usage details" })).toBeNull());
  });

  it("draws used share as mint, amber and signal rings, with empty unknown and full rejected readings", async () => {
    const { env } = await opened();
    env.setUsage([reading("account-1", WORK, [window("five_hour", 0.2, "2026-09-25T09:00:00.000Z"), window("seven_day", 0.8, "2026-09-25T09:00:00.000Z"), window("model_scoped:opus", 0.95, "2026-09-25T09:00:00.000Z")])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    for (const [name, tone, value] of [["5-hour 20%", "text-mint", "20"], ["Weekly 80%", "text-amber", "80"], ["Weekly, Opus 95%", "text-signal", "95"]] as const) {
      const ring = await within(gauge).findByRole("img", { name });
      expect(ring.tagName).toBe("svg");
      expect(ring.getAttribute("class")).toContain(tone);
      expect(ring.textContent).toBe(value);
      expect((ring.querySelector('[data-usage-arc]') as SVGCircleElement).style.strokeDasharray).toBe(`${value} 100`);
    }
    env.setUsage([reading("account-1", WORK, [{ ...window("five_hour", 0, "2026-09-25T09:05:00.000Z"), utilisation: null }, { ...window("seven_day", 0, "2026-09-25T09:05:00.000Z", "rejected"), utilisation: null }])]);
    const unknown = await within(gauge).findByRole("img", { name: "5-hour —" });
    expect(unknown.textContent).toBe("—");
    expect((unknown.querySelector('[data-usage-arc]') as SVGCircleElement).style.strokeDasharray).toBe("0 100");
    const refused = within(gauge).getByRole("img", { name: "Weekly — out" });
    expect(refused.textContent).toBe("!");
    expect((refused.querySelector('[data-usage-arc]') as SVGCircleElement).style.strokeDasharray).toBe("100 100");
  });

  it("captions a weekly bucket by its model alone, keeps the window's name in the tooltip, and truncates rather than abbreviates", async () => {
    const { env } = await opened();
    env.setUsage([reading("account-1", WORK, [window("seven_day", 0.8, "2026-09-25T09:00:00.000Z"), window("model_scoped:fable", 0.95, "2026-09-25T09:00:00.000Z")])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    const fable = await within(gauge).findByText("Fable");
    expect(within(gauge).getByText("Weekly")).toBeTruthy();
    expect(within(gauge).queryByText(/^Weekly,/)).toBeNull();
    expect(fable.className).toContain("truncate");
    expect(within(gauge).getByRole("button", { name: "Usage details" }).className.split(" ")).not.toContain("shrink-0");
    expect(within(gauge).getByRole("img", { name: "Weekly, Fable 95%" })).toBeTruthy();
    act(() => within(gauge).getByRole("button", { name: "Usage details" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Weekly 80% · Weekly, Fable 95%");
  });

  it("pools the session's account identity across two environments, each window from the reading that observed it last", async () => {
    const { app, env } = await opened([desk(), { name: "laptop", reach: "paired", accounts: [{ id: "account-9", label: "work", identity: WORK }] }]);
    env.setUsage([reading("account-1", WORK, [window("five_hour", 0.42, "2026-09-25T09:00:00.000Z")])]);
    app.environment("laptop").setUsage([reading("account-9", WORK, [window("five_hour", 0.61, "2026-09-25T09:05:00.000Z"), window("seven_day", 0.12, "2026-09-25T09:05:00.000Z")])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    await waitFor(() => expect(gauge.textContent).toBe("5-hour 61Weekly 12"));
  });

  it("marks a window the provider refuses as out", async () => {
    const { env } = await opened();
    env.setUsage([reading("account-1", WORK, [window("five_hour", 1, "2026-09-25T09:00:00.000Z", "rejected")])]);
    const gauge = await within(statusLine()).findByRole("group", { name: "Plan usage" });
    await waitFor(() => expect(gauge.textContent).toBe("5-hour 100"));
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
    await screen.findByText("1m 04s");
    expect(screen.getByRole("status", { name: "Run activity" }).textContent).toContain("Running a command");
    expect(lineText()).toContain("3.5k tok · $0.042");
    expect(lineText()).not.toContain("Running a command");

    env.endRun(session, runId, {
      usage: [{ model: "claude-opus-4", inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }],
    });
    await waitFor(() => expect(lineText()).toContain("4.0k tok · $0.050"));
    expect(within(statusLine()).queryByText("idle")).toBeNull();
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
    const dialog = screen.getByRole("dialog", { name: "Run info" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    for (const name of ["Run", "Account", "Usage", "Capabilities", "Tools"]) expect(within(dialog).getByRole("region", { name })).toBeTruthy();
    const fact = (term: string) => within(info).getByText(term, { selector: "dt" }).nextElementSibling?.textContent;
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
    await app.user.keyboard("{Control>}i{/Control}");
    expect(await screen.findByText("No run yet: the session's first message starts one.")).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("No run yet: the session's first message starts one.")).toBeNull());
  });
});

describe("current context meter", () => {
  it("shows unknown before a run, known zero on start, then current request share independently of spend", async () => {
    const { app, env, session } = await opened([desk({ provider: { contextReadings: true }, models: [{ accountId: "account-1", models: [{ id: "claude-opus-4", family: "opus", tier: 1, label: null, efforts: [], contextWindow: 1000 }] }] })]);
    const meter = await within(statusLine()).findByRole("img", { name: "Context: unknown" });
    expect(meter.textContent).toBe("—");
    const contextButton = within(statusLine()).getByRole("button", { name: "Context usage" });
    expect(within(contextButton).getByText("Context").className).toContain("truncate");
    expect(contextButton.className.split(" ")).not.toContain("shrink-0");
    expect(within(statusLine()).queryByText("Ctx")).toBeNull();
    act(() => contextButton.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Context usage: Context reading unknown");
    act(() => contextButton.blur());
    const { runId } = env.startRun(session, "Check context");
    expect(await within(statusLine()).findByRole("img", { name: "Context: 0%" })).toBeTruthy();
    env.emit(session, "context.reported", { runId, model: "claude-opus-4", contextTokens: 800, contextWindow: null });
    expect(await within(statusLine()).findByRole("img", { name: "Context: 80%" })).toBeTruthy();
    await app.user.click(within(statusLine()).getByRole("button", { name: "Usage details" }));
    const planDetails = await screen.findByRole("dialog", { name: "Usage details" });
    expect(within(planDetails).getByText("Current request context appears in the Context meter when supported.")).toBeTruthy();
    expect(within(planDetails).queryByText(/Context tokens are not reported/)).toBeNull();
    await app.user.keyboard("{Escape}");
    await app.user.click(within(statusLine()).getByRole("button", { name: "Context usage" }));
    expect(await screen.findByText("800 / 1,000 tokens")).toBeTruthy();
    await app.user.keyboard("{Escape}");
    env.emit(session, "usage.reported", { runId, models: [{ model: "claude-opus-4", inputTokens: 9000, outputTokens: 500, cacheReadTokens: 4000, cacheWriteTokens: 0, costUsd: null, contextWindow: 1000 }] });
    expect(await within(statusLine()).findByRole("img", { name: "Context: 80%" })).toBeTruthy();
    env.emit(session, "context.reported", { runId, model: "model-b", contextTokens: 1200, contextWindow: 1000 });
    const full = await within(statusLine()).findByRole("img", { name: "Context: 100%" });
    expect(full.textContent).toBe("100");
    env.emit(session, "context.reported", { runId, model: "model-c", contextTokens: 400, contextWindow: null });
    expect(await within(statusLine()).findByRole("img", { name: "Context: unknown" })).toBeTruthy();
    env.emit(session, "context.reported", { runId, model: "model-b", contextTokens: 200, contextWindow: null });
    expect(await within(statusLine()).findByRole("img", { name: "Context: 20%" })).toBeTruthy();
    env.endRun(session, runId);
    expect(await within(statusLine()).findByRole("img", { name: "Context: 20%" })).toBeTruthy();
  });
  it("keeps an unknown scale honest and omits the ring without the capability", async () => {
    const { app, env, session } = await opened([desk({ provider: { contextReadings: true } }), { name: "other", reach: "paired", provider: { contextReadings: false }, accounts: [{ id: "other-account" }], sessions: [{ title: "Other", accountId: "other-account" }] }]);
    const { runId } = env.startRun(session, "Unknown scale");
    env.emit(session, "context.reported", { runId, model: "claude-opus-4", contextTokens: 400, contextWindow: null });
    expect(await within(statusLine()).findByRole("img", { name: "Context: unknown" })).toBeTruthy();
    await app.user.click(within(statusLine()).getByRole("button", { name: "Context usage" }));
    expect(await screen.findByText("400 tokens · unknown scale")).toBeTruthy();
    await app.user.keyboard("{Escape}");
    app.open("other");
    await screen.findByText("Nothing said yet.");
    expect(within(statusLine()).queryByRole("button", { name: "Context usage" })).toBeNull();
  });
});
