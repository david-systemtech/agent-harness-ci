import { act, screen, waitFor, within } from "@testing-library/react";
import type { AccountUsage, HandoffRecommendation } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The status line's pickers and the dialogs they open (docs/specs/gui.md, "A
 * session pane": pickers per environment; #402): the mode picker with the
 * clamp, the containment picker greying a level the environment cannot
 * enforce, the model picker whose choice rides the next run, the account
 * picker with its sign-in card, the hand-off offer and picker forking onto
 * another account, and a picker the connection cannot use dim with its
 * reason. Driven through the harness over the scripted environment.
 */

const WORK = { provider: "claude", email: "milo@work.test", organisation: null };
const HOME = { provider: "claude", email: "milo@home.test", organisation: null };
const BYPASS = "The agent will act without asking and can do anything this account can, within the containment you chose.";

const desk = (more: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  accounts: [
    { id: "account-1", label: "work", identity: WORK },
    { id: "account-2", label: "personal", identity: HOME },
  ],
  sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4", mode: "acceptEdits" }],
  settings: { "permissions.containment.default": "workspace" },
  ...more,
});

const opened = async (environments: readonly ScriptedEnvironment[] = [desk()]) => {
  const app = await renderApp({ environments });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, session: env.sessionId() };
};

const statusLine = () => screen.getByRole("region", { name: "Status line" });

/** The pane's one line, under the composer. */
const paneLine = () => within(screen.getByRole("region", { name: "Session pane" })).queryAllByRole("status").at(-1)?.textContent;

/** What the transient lane says now, newest last (#1823): a mode set as asked is said there, once, not on the pane's line. */
const feedback = () => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"]) [data-title]')].map((title) => title.textContent);

/** Opens the picker whose button's name starts with `name` (`Mode`), as a person tabbing to it and pressing Enter does. */
const openPicker = async (app: RenderedApp, name: string) => {
  const button = await within(statusLine()).findByRole("button", { name: new RegExp(`^${name}: `) });
  act(() => button.focus());
  await app.user.keyboard("{Enter}");
  return screen.findByRole("menu");
};

/** The requests sent for `method`, their params alone. */
const sent = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);

const reading = (accountId: string, identity: AccountUsage["identity"], windows: AccountUsage["windows"], unavailableReason: string | null = null): AccountUsage => ({
  accountId,
  identity,
  windows,
  readAt: "2026-09-25T09:00:00.000Z",
  unavailableReason,
});
const window = (name: string, utilisation: number, verdict: "rejected" | null = null) => ({
  window: name,
  utilisation,
  resetsAt: "2026-09-25T14:30:00.000Z",
  verdict,
  observedAt: "2026-09-25T09:00:00.000Z",
});

describe("the mode picker", () => {
  it("greys the modes above the connection's ceiling with the ceiling named, sets permissions.mode.set, and shows the clamp its answer gives", async () => {
    const { app, env, session } = await opened([desk({ hello: { ceiling: "auto" } })]);
    const menu = await openPicker(app, "Mode");
    const bypass = within(menu).getByRole("menuitem", { name: /^BYPASS/ });
    expect(bypass.textContent).toContain("above this connection's ceiling (auto)");
    expect(bypass.textContent).toContain(BYPASS);
    expect(within(menu).getByRole("menuitem", { name: /^accept edits/ }).textContent).toContain("this session");
    expect(within(menu).getByRole("menuitem", { name: /^auto/ }).textContent).not.toContain("above");

    await app.user.click(bypass);
    await waitFor(() => expect(paneLine()).toBe("Asked for bypassPermissions; Receipts has auto: clamped to this connection's ceiling (auto)."));
    expect(sent(env, "permissions.mode.set")).toEqual([expect.objectContaining({ sessionId: session, mode: "bypassPermissions" })]);
    expect(await within(statusLine()).findByRole("button", { name: "Mode: auto" })).toBeTruthy();
  });

  it("sets a mode within the ceiling and says it once, as a transient notice, with no standing line under the composer", async () => {
    const { app } = await opened();
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^plan/ }));
    await waitFor(() => expect(feedback()).toContain("Mode: plan."));
    expect(paneLine()).toBeUndefined();
    expect(await within(statusLine()).findByRole("button", { name: "Mode: plan" })).toBeTruthy();
  });

  it("says bypassPermissions once as it changes, with the permissions spec's sentence, and the mode control shows it from then on", async () => {
    const { app } = await opened();
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^BYPASS/ }));
    await waitFor(() => expect(feedback()).toContain(`Mode: bypassPermissions. ${BYPASS}`));
    expect(paneLine()).toBeUndefined();
    expect(await within(statusLine()).findByRole("button", { name: "Mode: BYPASS" })).toBeTruthy();
  });

  it("shows a session in bypassPermissions by the mode control alone: its label and colour, the sentence in its tooltip", async () => {
    await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4", mode: "bypassPermissions" }] })]);
    const mode = await within(statusLine()).findByRole("button", { name: "Mode: BYPASS" });
    expect(mode.querySelector(".text-signal")?.textContent).toBe("BYPASS");
    expect(paneLine()).toBeUndefined();
    act(() => mode.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain(`Mode: BYPASS · /mode · ${BYPASS}`);
  });

  it("keeps one mode notice: a later set replaces the earlier one's, and a clamp takes it away", async () => {
    const { app } = await opened([desk({ hello: { ceiling: "auto" } })]);
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^plan/ }));
    await waitFor(() => expect(feedback()).toEqual(["Mode: plan."]));
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^auto/ }));
    await waitFor(() => expect(feedback()).toEqual(["Mode: auto."]));
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^BYPASS/ }));
    await waitFor(() => expect(paneLine()).toBe("Asked for bypassPermissions; Receipts has auto: clamped to this connection's ceiling (auto)."));
    await waitFor(() => expect(feedback()).toEqual([]));
  });

  it("clears an earlier clamp's line once a mode is set as asked", async () => {
    const { app } = await opened([desk({ hello: { ceiling: "auto" } })]);
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^BYPASS/ }));
    await waitFor(() => expect(paneLine()).toBe("Asked for bypassPermissions; Receipts has auto: clamped to this connection's ceiling (auto)."));
    await app.user.click(within(await openPicker(app, "Mode")).getByRole("menuitem", { name: /^plan/ }));
    await waitFor(() => expect(feedback()).toContain("Mode: plan."));
    expect(paneLine()).toBeUndefined();
  });
});

describe("the containment picker", () => {
  const unenforceable: ScriptedEnvironment["containment"] = {
    levels: [
      { level: "off", available: true, reason: null, cause: null },
      { level: "workspace", available: true, reason: null, cause: null },
      { level: "workspace-no-network", available: false, reason: "No network namespace can be made here.", cause: "socat_missing" },
    ],
  };

  it("greys a level the environment cannot enforce with its reason, marks the default, and sets the one chosen", async () => {
    const { app, env, session } = await opened([desk({ containment: unenforceable })]);
    await within(statusLine()).findByRole("button", { name: "Containment: workspace (default)" });
    const menu = await openPicker(app, "Containment");
    expect(within(menu).getByRole("menuitem", { name: /^no network/ }).textContent).toContain("not available here: No network namespace can be made here.");
    expect(within(menu).getByRole("menuitem", { name: /^workspace/ }).textContent).toContain("the default");

    await app.user.click(within(menu).getByRole("menuitem", { name: /^off/ }));
    await waitFor(() => expect(paneLine()).toBe("Containment: off, from the next run of Receipts."));
    expect(sent(env, "permissions.containment.set")).toEqual([expect.objectContaining({ sessionId: session, level: "off" })]);
    expect(await within(statusLine()).findByRole("button", { name: "Containment: off" })).toBeTruthy();
  });

  it("says in one line that a level the environment cannot enforce was refused", async () => {
    const { app } = await opened([desk({ containment: unenforceable })]);
    await app.user.click(within(await openPicker(app, "Containment")).getByRole("menuitem", { name: /^no network/ }));
    await waitFor(() => expect(paneLine()).toBe("workspace-no-network cannot be enforced on desk: No network namespace can be made here."));
  });
});

describe("the model picker", () => {
  const models = [
    {
      accountId: "account-1",
      live: true,
      models: [
        { id: "claude-opus-4", family: "opus", tier: 3, efforts: ["low", "high"], label: "Opus" },
        { id: "claude-haiku-4", family: "haiku", tier: 1, efforts: [], label: null },
      ],
    },
  ];

  it("opens the same dependency columns from either chip and keeps the menu open after choosing a model", async () => {
    const { app } = await opened([desk({ models })]);
    let menu = await openPicker(app, "Account");
    expect(within(menu).getByRole("group", { name: "Accounts" })).toBeTruthy();
    expect(within(menu).getByRole("group", { name: "Models" })).toBeTruthy();
    expect(within(menu).getByRole("group", { name: "Effort" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
    menu = await openPicker(app, "Model");
    await app.user.click(within(menu).getByRole("menuitem", { name: "claude-haiku-4" }));
    expect(screen.getByRole("menu")).toBe(menu);
    expect(within(menu).queryByRole("group", { name: "Effort" })).toBeNull();
    await app.user.click(within(menu).getByRole("menuitem", { name: "Opus (claude-opus-4)" }));
    expect(within(menu).getByRole("group", { name: "Effort" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
    expect(within(statusLine()).getByRole("button", { name: /^Model:/ })).toBe(document.activeElement);
  });

  it("moves within a column and tabs between columns, with permission and browser submenus", async () => {
    const { app } = await opened([desk({ models })]);
    const menu = await openPicker(app, "Model");
    const list = within(menu).getByRole("group", { name: "Models" });
    act(() => within(list).getByRole("menuitem", { name: "Opus (claude-opus-4)" }).focus());
    await app.user.keyboard("{End}");
    expect(document.activeElement).toBe(within(list).getByRole("menuitem", { name: "claude-haiku-4" }));
    await app.user.keyboard("{Home}{Tab}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "its own effort" }));
    await app.user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(within(list).getByRole("menuitem", { name: "Opus (claude-opus-4)" }));
    await app.user.keyboard("{Tab}{Tab}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Mode" }));
    await app.user.keyboard("{ArrowRight}");
    const modes = await screen.findByRole("menu", { name: "Mode" });
    expect(modes.className).toContain("w-72");
    act(() => within(modes).getByRole("menuitem", { name: /^plan/ }).focus());
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(feedback()).toContain("Mode: plan."));
  });

  it("shows one dependency at a time at 360px and keeps model and effort choices when going back", async () => {
    const previousWidth = globalThis.window.innerWidth;
    Object.defineProperty(globalThis.window, "innerWidth", { configurable: true, value: 360 });
    onTestFinished(() => { Object.defineProperty(globalThis.window, "innerWidth", { configurable: true, value: previousWidth }); });
    const { app } = await opened([desk({ models })]);
    const trigger = within(statusLine()).getByRole("button", { name: /^Account:/ });
    await app.user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Run choices" });
    expect(dialog.hasAttribute("data-run-sheet")).toBe(true);
    expect(within(dialog).getByRole("group", { name: "Accounts" })).toBeTruthy();
    expect(within(dialog).queryByRole("group", { name: "Models" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Effort" })).toBeNull();
    expect(within(dialog).queryByText("desk")).toBeNull();
    await app.user.click(within(dialog).getByRole("button", { name: "Next: Models" }));
    expect(within(dialog).queryByRole("group", { name: "Accounts" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Effort" })).toBeNull();
    await app.user.click(within(dialog).getByRole("menuitem", { name: "Opus (claude-opus-4)" }));
    expect(within(dialog).getByRole("group", { name: "Effort" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /^Next:/ })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Models" })).toBeNull();
    await app.user.click(within(dialog).getByRole("button", { name: "Back: Models" }));
    expect(within(dialog).getByRole("menuitem", { name: "Opus (claude-opus-4)" }).className).toContain("bg-wash");
    await app.user.click(within(dialog).getByRole("menuitem", { name: "claude-haiku-4" }));
    expect(within(dialog).queryByRole("group", { name: "Effort" })).toBeNull();
    await app.user.click(within(dialog).getByRole("button", { name: "Back: Accounts" }));
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run choices" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("searches a long catalogue and takes ArrowDown from search into the models column", async () => {
    const many = Array.from({ length: 15 }, (_, index) => ({ id: `model-${index}`, family: "sample", tier: index, efforts: [], label: `Model ${index}` }));
    const { app } = await opened([desk({ models: [{ accountId: "account-1", live: true, models: many }] })]);
    const menu = await openPicker(app, "Model");
    const search = within(menu).getByRole("textbox", { name: "Search models" });
    await app.user.type(search, "model-14");
    const result = within(menu).getByRole("menuitem", { name: "Model 14 (model-14)" });
    expect(within(menu).queryByRole("menuitem", { name: "Model 1 (model-1)" })).toBeNull();
    await app.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "All models" }));
    await app.user.click(result);
    await app.user.keyboard("{Escape}");
    expect(within(statusLine()).getByRole("button", { name: "Model: Model 14" })).toBeTruthy();
  });

  it("keeps accounts and models visible with a reason during a live run and sends no change", async () => {
    const { app, env, session } = await opened([desk({ models })]);
    act(() => env.startRun(session, "Check the receipts"));
    const menu = await openPicker(app, "Account");
    expect(within(menu).getByText("Wait for this run to end before changing its account or model.")).toBeTruthy();
    await app.user.click(within(menu).getByRole("menuitem", { name: /^personal/ }));
    await app.user.click(within(menu).getByRole("menuitem", { name: "claude-haiku-4" }));
    expect(sent(env, "sessions.fork")).toEqual([]);
    expect(within(statusLine()).getByRole("button", { name: /^Model: Opus/ })).toBeTruthy();
  });

  it("lists the models of the session's account with their efforts, and the choice goes with the session's next run", async () => {
    const { app, env, session } = await opened([desk({ models })]);
    const menu = await openPicker(app, "Model");
    const opus = await within(menu).findByRole("group", { name: "Effort" });
    expect(within(opus).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["its own effortthis sessionLet the model choose its effort.", "LowReasoning effort for the next run.", "HighReasoning effort for the next run."]);
    expect(within(menu).getByRole("menuitem", { name: "claude-haiku-4" })).toBeTruthy();

    await app.user.click(within(opus).getByRole("menuitem", { name: "High" }));
    await waitFor(() => expect(paneLine()).toBe("The next run of Receipts goes out on Opus - High."));
    expect(within(statusLine()).getByRole("button", { name: "Model: Opus - High" })).toBeTruthy();

    const box = screen.getByRole("textbox", { name: "Message" });
    act(() => box.focus());
    await app.user.keyboard("Fix the receipts{Enter}");
    await waitFor(() => expect(sent(env, "runs.start")).toEqual([expect.objectContaining({ sessionId: session, text: "Fix the receipts", model: "claude-opus-4", effort: "high" })]));
  });
  it("names the model and effort as the provider does, in the trigger, the rows and the line it says", async () => {
    const fable = [{ accountId: "account-1", live: false, models: [{ id: "fable", family: "fable", tier: 3, efforts: ["low", "medium", "high"], label: "Fable" }] }];
    const { app } = await opened([desk({ models: fable })]);
    const menu = await openPicker(app, "Model");
    const row = within(menu).getByRole("menuitem", { name: "Fable 5.1 (fable)" });
    expect(row.textContent).toBe("Fable 5.1fableSupports effort");
    await app.user.click(row);
    const efforts = within(menu).getByRole("group", { name: "Effort" });
    expect(within(efforts).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"))).toEqual(["its own effort", "Low", "Medium", "High"]);
    await app.user.click(within(efforts).getByRole("menuitem", { name: "High" }));
    await waitFor(() => expect(paneLine()).toBe("The next run of Receipts goes out on Fable 5.1 - High."));
    expect(within(statusLine()).getByRole("button", { name: "Model: Fable 5.1 - High" })).toBeTruthy();
  });

  it("finds a model in a long catalogue by the name its row shows", async () => {
    const samples = Array.from({ length: 13 }, (_, index) => ({ id: `model-${index}`, family: "sample", tier: index, efforts: [], label: `Model ${index}` }));
    const listed = [{ id: "fable", family: "fable", tier: 3, efforts: ["high"], label: "Fable" }, ...samples];
    const { app } = await opened([desk({ models: [{ accountId: "account-1", live: true, models: listed }] })]);
    const menu = await openPicker(app, "Model");
    await app.user.type(within(menu).getByRole("textbox", { name: "Search models" }), "Fable 5.1");
    expect(within(menu).getByRole("menuitem", { name: "Fable 5.1 (fable)" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Model 1 (model-1)" })).toBeNull();
  });
});

describe("the account picker", () => {
  it("keeps the signed-out phone account reachable with a constrained grant", async () => {
    const width = globalThis.window.innerWidth;
    Object.defineProperty(globalThis.window, "innerWidth", { configurable: true, value: 360 });
    onTestFinished(() => { Object.defineProperty(globalThis.window, "innerWidth", { configurable: true, value: width }); });
    const { app } = await opened([desk({ scopes: ["read", "sessions:write", "runs:drive"], accounts: [{ id: "claude-max", label: "claude-max", status: { state: "signed-out", checkedAt: null, detail: null } }], sessions: [{ title: "Receipts", accountId: "claude-max" }] })]);
    const trigger = within(statusLine()).getByRole("button", { name: /^Account:/ });
    act(() => trigger.focus());
    await app.user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Run choices" });
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run choices" })).toBeNull());
    await app.user.pointer({ target: trigger, keys: "[MouseLeft>]" });
    expect(screen.queryByRole("dialog", { name: "Run choices" })).toBeNull();
    await app.user.pointer({ target: trigger, keys: "[/MouseLeft]" });
    const sheet = await screen.findByRole("dialog", { name: "Run choices" });
    const accounts = within(sheet).getByRole("group", { name: "Accounts" });
    const account = within(accounts).getByRole("menuitem", { name: /claude-max/ });
    expect(account.textContent).toContain("signed out");
    await app.user.click(account);
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(paneLine()).toContain("Cannot sign claude-max in"));
  });
  it("lists the environment's accounts with their identity, sign-in status and one usage ring per plan window, the reading in the rings' tooltip, then Add an account (ticket 1822)", async () => {
    const { app, env } = await opened([
      desk({
        accounts: [
          { id: "account-1", label: "work", identity: WORK },
          { id: "account-2", label: "personal", identity: HOME, status: { state: "expired", checkedAt: null, detail: null } },
          { id: "account-3", label: "spare", identity: { provider: "claude", email: "milo@spare.test", organisation: null } },
        ],
      }),
    ]);
    env.setUsage([
      reading("account-1", WORK, [window("five_hour", 0.42), window("seven_day", 0.8)]),
      reading("account-2", HOME, [], "Not signed in."),
      reading("account-3", { provider: "claude", email: "milo@spare.test", organisation: null }, [window("five_hour", 0.95)]),
    ]);
    await within(statusLine()).findByRole("group", { name: "Plan usage" });
    const menu = await openPicker(app, "Account");
    const work = within(menu).getByRole("menuitem", { name: /^work/ });
    const personal = within(menu).getByRole("menuitem", { name: /^personal/ });
    const spare = within(menu).getByRole("menuitem", { name: /^spare/ });
    // The words are gone from the row: the rings draw them, and the tooltip says them.
    expect(work.textContent).toBe("work milo@work.testsigned in · this session · claude");
    expect(personal.textContent).toBe("personal milo@home.testsign-in expired · Sign in · claude");
    const rings = (row: HTMLElement) => within(row).queryAllByRole("img").map((ring) => [ring.getAttribute("aria-label"), ring.getAttribute("class")?.match(/text-(mint|amber|signal)/)?.[1]]);
    expect(rings(work)).toEqual([["5-hour 42%", "mint"], ["Weekly 80%", "amber"]]);
    expect(rings(spare)).toEqual([["5-hour 95%", "signal"]]);
    expect(rings(personal)).toEqual([]);
    // The status line's own ring, drawn compact: the same arc, at 16px.
    const ring = within(work).getByRole("img", { name: "5-hour 42%" });
    expect([ring.getAttribute("width"), ring.querySelector("[data-usage-arc]")?.getAttribute("style")]).toEqual(["16", "stroke-dasharray: 42 100;"]);
    // Every account row keeps its one fixed-height ring line, whether it holds two rings, one or none.
    for (const row of [work, spare, personal]) expect(row.querySelectorAll("[data-usage-rings].h-4")).toHaveLength(1);
    // The row's native title stops at the ring line, so it never draws over the rings' own tooltip.
    expect([work.title.startsWith("work milo@work.test"), work.querySelector("[data-usage-rings]")?.getAttribute("title")]).toEqual([true, ""]);
    expect(within(personal).getByRole("group", { name: "Not signed in." })).toBeTruthy();
    await app.user.hover(within(work).getByRole("group", { name: "5-hour 42% · Weekly 80%" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("5-hour 42% · Weekly 80%");
    expect(within(menu).getByRole("menuitem", { name: "Add an account…" })).toBeTruthy();
  });

  it("hands the open session off onto another signed-in account: a fork onto it, carrying the draft, opened in the pane", async () => {
    const { app, env, session } = await opened([desk({ sessions: [{ title: "Receipts", accountId: "account-1", draft: "and the tests" }] })]);
    await app.user.click(within(await openPicker(app, "Account")).getByRole("menuitem", { name: /^personal/ }));
    await waitFor(() => expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session, account: "account-2" })]));
    const fork = String(sent(env, "sessions.fork")[0]?.["id"]);
    await waitFor(() => expect(app.shown()).toEqual({ environmentId: env.environmentId, sessionId: fork }));
    await waitFor(() => expect(env.summary(fork).draft).toBe("and the tests"));
    expect(await within(statusLine()).findByRole("button", { name: "Account: personal milo@home.test" })).toBeTruthy();
  });

  it("names the session's account by the label last seen when the window opens while its environment is not answering, never by its id (ticket 1752)", async () => {
    const team = "da2d4db4-7bec-465c-b7ec-91938a15e3d2";
    const unseen = "175f15dd-2b8e-4c3a-9d41-6a7e0f3c2b19";
    const { app, env } = await opened([desk({
      accounts: [{ id: "0bcb960d-1b0b-48d8-81f6-49fe44341431", label: "Personal mail", identity: HOME }, { id: team, label: "Team", identity: WORK }],
      sessions: [{ title: "Receipts", accountId: team }, { title: "Elsewhere", accountId: unseen }],
    })]);
    expect(await within(statusLine()).findByRole("button", { name: "Account: Team milo@work.test" })).toBeDefined();
    // A session on an account the environment does not list is named as one.
    app.open("desk", 1);
    expect(await within(statusLine()).findByRole("button", { name: "Account: an account not read yet" })).toBeDefined();
    expect(statusLine().textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    app.open("desk", 0);
    await within(statusLine()).findByRole("button", { name: "Account: Team milo@work.test" });

    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.remount();
    await screen.findByText("Cached: what this window last saw of it; desk is not answering");
    const chip = await within(statusLine()).findByRole("button", { name: "Account: Team · last seen" });
    expect(chip.textContent).toBe("Team · last seen");
    expect(statusLine().textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("says the session is on the account already", async () => {
    const { app, env } = await opened();
    await app.user.click(within(await openPicker(app, "Account")).getByRole("menuitem", { name: /^work/ }));
    await waitFor(() => expect(paneLine()).toBe("Receipts runs on work already."));
    expect(sent(env, "sessions.fork")).toEqual([]);
  });
});

describe("the hand-off offer and picker", () => {
  const out: Partial<HandoffRecommendation> = {
    accountId: "account-2",
    reason: "limit-reached",
    message: "The 5-hour window of work is out until 14:30; personal has the most room (88%).",
    trigger: { threshold: "five_hour", label: "5-hour", at: 0.9, window: "five_hour", utilisation: 1, verdict: "rejected" },
    headroom: 0.88,
    binding: "five_hour",
    candidates: 1,
    basis: "same-plan",
  };

  it("offers the hand-off in the recommendation's words while the account's window is out and no run is live", async () => {
    const { env, session } = await opened([desk({ recommendation: out })]);
    await within(statusLine()).findByText(out.message as string);
    const { runId } = env.startRun(session, "one more thing");
    await waitFor(() => expect(within(statusLine()).queryByText(out.message as string)).toBeNull());
    env.endRun(session, runId);
    expect(await within(statusLine()).findByText(out.message as string)).toBeTruthy();
  });

  it("keeps the hand-off open and refuses duplicates and dismissal until the environment answers", async () => {
    const { app, env } = await opened([desk({ recommendation: out })]);
    env.setUsage([reading("account-1", WORK, [window("five_hour", 1, "rejected")])]);
    let release: (() => void) | undefined;
    env.wire.answer("sessions.fork", () => new Promise((resolve) => { release = () => resolve({ error: { code: "conflict", message: "The account is busy.", data: {} } }); }));
    await app.user.click(await within(statusLine()).findByRole("button", { name: "Hand off…" }));
    const dialog = await screen.findByRole("dialog", { name: "Hand off Receipts on desk" });
    const candidate = await within(dialog).findByRole("button", { name: /^personal/ });
    await app.user.click(candidate);
    await waitFor(() => expect(sent(env, "sessions.fork")).toHaveLength(1));
    expect(candidate).toHaveProperty("disabled", true);
    await app.user.keyboard("{Enter}{Escape}");
    expect(screen.getByRole("dialog", { name: "Hand off Receipts on desk" })).toBeTruthy();
    expect(sent(env, "sessions.fork")).toHaveLength(1);
    act(() => release?.());
    expect(await within(dialog).findByText("Not handed off: The account is busy.")).toBeTruthy();
    await app.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hand off Receipts on desk" })).toBeNull());
  });

  it("names each account's models in the hand-off picker as the model picker does", async () => {
    const fable = [{ accountId: "account-2", live: false, models: [{ id: "fable", family: "fable", tier: 3, efforts: ["high"], label: "Fable" }] }];
    const { app } = await opened([desk({ recommendation: out, models: fable })]);
    await app.user.click(await within(statusLine()).findByRole("button", { name: "Hand off…" }));
    const accounts = within(await screen.findByRole("dialog", { name: "Hand off Receipts on desk" })).getByRole("list", { name: "Accounts" });
    expect(await within(accounts).findByText("Models: Fable 5.1 (fable)")).toBeTruthy();
  });

  it("opens the hand-off picker: the environment's accounts with their status and plan readings, the recommended one marked; choosing one forks onto it", async () => {
    const { app, env, session } = await opened([desk({ recommendation: out })]);
    env.setUsage([reading("account-1", WORK, [window("five_hour", 1, "rejected")]), reading("account-2", HOME, [window("five_hour", 0.12)])]);
    await app.user.click(await within(statusLine()).findByRole("button", { name: "Hand off…" }));
    const dialog = await screen.findByRole("dialog", { name: "Hand off Receipts on desk" });
    expect(dialog.textContent).toContain(out.message);
    const accounts = within(dialog).getByRole("list", { name: "Accounts" });
    await waitFor(() => expect(within(accounts).getByRole("button", { name: /^work/ }).textContent).toContain("work milo@work.test signed in · this session5-hour 100% out"));
    expect(within(accounts).getByRole("button", { name: /^personal/ }).textContent).toContain("personal milo@home.test signed in · recommended5-hour 12%");
    expect(within(accounts).getByText("hand-off between environments comes in milestone 2 (ADR 0005)")).toBeTruthy();

    await app.user.click(within(accounts).getByRole("button", { name: /^personal/ }));
    await waitFor(() => expect(sent(env, "sessions.fork")).toEqual([expect.objectContaining({ sessionId: session, account: "account-2" })]));
    expect(screen.queryByRole("dialog")).toBeNull();
    const fork = String(sent(env, "sessions.fork")[0]?.["id"]);
    await waitFor(() => expect(app.shown()?.sessionId).toBe(fork));
  });
});

describe("sign-in", () => {
  it("lets the local provider browser complete without opening its manual-code URL, with a paste fallback", async () => {
    const { app, env } = await opened();
    await app.user.click(within(await openPicker(app, "Account")).getByRole("menuitem", { name: "Add an account…" }));
    const card = await screen.findByRole("dialog", { name: "Add an account on desk" });
    await app.user.type(within(card).getByRole("textbox", { name: "Label for the new account" }), "side{Enter}");
    await waitFor(() => expect(sent(env, "accounts.add")).toEqual([expect.objectContaining({ label: "side" })]));
    const signing = await screen.findByRole("dialog", { name: "Sign in: side on desk" });
    await within(signing).findByText("Starting the sign-in…");

    env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true&state=abc" });
    await within(signing).findByText("https://claude.ai/oauth/authorize?code=true&state=abc");
    expect(app.shell.calls.filter(([method]) => method === "openExternal")).toEqual([]);
    expect(within(signing).getByText(/Finish signing in in the browser on this machine/)).toBeDefined();
    expect(within(signing).getByText("Or run this in a terminal on desk's machine:")).toBeTruthy();
    expect(within(signing).getByText("CLAUDE_CONFIG_DIR='/home/milo/.agent-harness/accounts/3' claude auth login")).toBeTruthy();

    await app.user.type(within(signing).getByRole("textbox", { name: "Then paste the code it shows" }), "  abc-123#abc  {Enter}");
    await waitFor(() => expect(sent(env, "accounts.signin.code")).toEqual([expect.objectContaining({ accountId: "account-3", code: "abc-123#abc" })]));
    await within(signing).findByText("Checking the code…");

    env.signIn("done");
    await waitFor(() => expect(paneLine()).toBe("side is signed in on desk."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts the sign-in of an account not signed in, and says a failure in one line", async () => {
    const { app, env } = await opened([desk({ accounts: [{ id: "account-1", label: "work", identity: WORK }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
    await app.user.click(within(await openPicker(app, "Account")).getByRole("menuitem", { name: /^personal/ }));
    await screen.findByRole("dialog", { name: "Sign in: personal on desk" });
    await waitFor(() => expect(sent(env, "accounts.signin.start")).toEqual([expect.objectContaining({ accountId: "account-2" })]));
    env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true" });
    await screen.findByRole("textbox", { name: "Then paste the code it shows" });
    env.signIn("failed", { error: "the provider's CLI exited 1" });
    await waitFor(() => expect(paneLine()).toBe("The sign-in of personal failed: the provider's CLI exited 1."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels the sign-in it started when the card is closed", async () => {
    const { app, env } = await opened([desk({ accounts: [{ id: "account-1", label: "work", identity: WORK }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
    await app.user.click(within(await openPicker(app, "Account")).getByRole("menuitem", { name: /^personal/ }));
    const card = await screen.findByRole("dialog", { name: "Sign in: personal on desk" });
    env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true" });
    await within(card).findByRole("textbox", { name: "Then paste the code it shows" });
    await app.user.click(within(card).getByRole("button", { name: "Cancel the sign-in" }));
    await waitFor(() => expect(sent(env, "accounts.signin.cancel")).toEqual([expect.objectContaining({ accountId: "account-2" })]));
    await waitFor(() => expect(paneLine()).toBe("The sign-in of personal was cancelled."));
  });

  it("caps the sign-in dialog at the window, keeps its title and actions out of the scrolling middle, and folds the long page link (ticket 1690)", async () => {
    const { app, env } = await opened([desk({ accounts: [{ id: "account-1", label: "work", identity: WORK }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
    await app.user.click(within(await openPicker(app, "Account")).getByRole("menuitem", { name: /^personal/ }));
    const card = await screen.findByRole("dialog", { name: "Sign in: personal on desk" });
    const url = `https://claude.test/oauth/authorize?code=true&scope=${"profile ".repeat(24).trim()}&state=for-tests`;
    env.signIn("awaiting-code", { url });
    await within(card).findByRole("textbox", { name: "Then paste the code it shows" });

    // look.md §11.1: the dialog stops at the window less its margin and only its middle scrolls.
    expect(card.className).toContain("max-h-[calc(100dvh-4rem)]");
    const middle = card.querySelector<HTMLElement>("[data-sign-in-body]");
    expect(middle?.className).toContain("overflow-y-auto");
    expect(middle?.className).toContain("min-h-0");
    expect(middle?.contains(within(card).getByRole("img", { name: "QR code of the provider sign-in page" }))).toBe(true);
    expect(middle?.contains(within(card).getByRole("region", { name: "Terminal fallback" }))).toBe(true);
    for (const outside of [card.querySelector("h2"), within(card).getByRole("button", { name: "Close dialog" }), within(card).getByRole("button", { name: "Send the code" }), within(card).getByRole("button", { name: "Cancel the sign-in" })]) {
      expect(outside).not.toBeNull();
      expect(middle?.contains(outside)).toBe(false);
    }

    // The page link takes at most two lines; copying and opening it carry the whole link.
    const link = within(card).getByText(url);
    expect(link.className).toContain("line-clamp-2");
    expect(link.getAttribute("title")).toBe(url);
    await app.user.click(within(card).getByRole("button", { name: "Copy the sign-in page link" }));
    expect(app.shell.calls.filter(([member]) => member === "clipboard.writeText").at(-1)?.slice(1)).toEqual([url]);

    // Send the code, outside the code's form, still sends what the form holds.
    await app.user.type(within(card).getByRole("textbox", { name: "Then paste the code it shows" }), "code-for-tests#for-tests");
    await app.user.click(within(card).getByRole("button", { name: "Send the code" }));
    await waitFor(() => expect(sent(env, "accounts.signin.code")).toEqual([expect.objectContaining({ accountId: "account-2", code: "code-for-tests#for-tests" })]));
  });

  it("says that a connection without admin cannot add or sign in an account", async () => {
    const { app, env } = await opened([desk({ scopes: ["read", "sessions:write", "runs:drive"] })]);
    const menu = await openPicker(app, "Account");
    const add = within(menu).getByRole("menuitem", { name: /^Add an account…/ });
    expect(add.textContent).toContain("This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.");
    await app.user.click(add);
    await waitFor(() => expect(paneLine()).toBe("Cannot add an account on desk: This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent(env, "accounts.add")).toEqual([]);
  });
});

describe("a picker the connection cannot use", () => {
  it("is dim with the capability's reason, which a press says on the pane's line", async () => {
    const { app, env } = await opened([desk({ scopes: ["read", "sessions:write"] })]);
    const mode = await within(statusLine()).findByRole("button", { name: /^Mode: / });
    expect(mode.getAttribute("aria-disabled")).toBe("true");
    act(() => mode.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Mode: accept edits · /mode · This app has limited access to desk, so it cannot run agents. Pair again with full access to change this.");
    await app.user.click(mode);
    await waitFor(() => expect(paneLine()).toBe("This app has limited access to desk, so it cannot run agents. Pair again with full access to change this."));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(statusLine()).getByRole("button", { name: /^Containment: / }).getAttribute("aria-disabled")).toBe("true");
    expect(sent(env, "permissions.mode.set")).toEqual([]);
  });
});

describe("the slash commands", () => {
  it("open the pickers from the composer: /mode the mode picker, /handoff the hand-off picker, and /handoff naming another environment says it is milestone 2's", async () => {
    const { app } = await opened();
    const box = screen.getByRole("textbox", { name: "Message" });
    act(() => box.focus());
    await app.user.keyboard("/mode{Enter}");
    // A picker's menu is named by its button.
    expect(await screen.findByRole("menu", { name: "Mode: accept edits" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    act(() => box.focus());
    await app.user.keyboard("/handoff laptop{Enter}");
    await waitFor(() => expect(paneLine()).toBe("Not handed off to laptop: hand-off between environments comes in milestone 2 (ADR 0005)."));
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => box.focus());
    await app.user.keyboard("/handoff{Enter}");
    expect(await screen.findByRole("dialog", { name: "Hand off Receipts on desk" })).toBeTruthy();
  });
});
