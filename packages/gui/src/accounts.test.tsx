import { screen, waitFor, within } from "@testing-library/react";
import type { AccountIdentity, AccountUsage } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Accounts rows (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0018, ADR 0027; #414): Accounts, the picked environment's
 * accounts with adopt, add and sign in, relabel and remove; Default account
 * and model, the Account step's four keys; and Usage, every gauge pooled by
 * account identity across the environments. Driven through the harness over
 * two scripted environments: `desk`, this machine's, and `laptop`, paired.
 */

/** Who milo signs in as, on either machine. */
const MILO: AccountIdentity = { provider: "claude", email: "milo@example.test", organisation: null };

/** The window with its two environments ready and no session open, each as `given` scripts it. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given.desk }, { name: "laptop", reach: "paired", ...given.laptop }] });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Opens Settings on the row labelled `label` with Mod+, and the rail, as a person does, the picker on `environment` when it is given. */
const openRow = async (app: RenderedApp, label: string, environment?: string) => {
  if (screen.queryByRole("region", { name: "Settings" }) === null) await app.user.keyboard("{Control>},{/Control}");
  const open = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(open).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: label }));
  if (environment !== undefined) await app.user.selectOptions(within(pane(label)).getByRole("combobox", { name: "Environment" }), environment);
  return pane(label);
};

/** A row's pane, by its label. */
const pane = (label: string) => within(settings()).getByRole("region", { name: label });

/** What a card says of its account, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

/** A reading of `accountId` as milo, its two windows as given. */
const reading = (accountId: string, fiveHour: number, week: number, observedAt = "2026-09-30T10:00:00.000Z"): AccountUsage => ({
  accountId,
  identity: MILO,
  windows: [
    { window: "five_hour", utilisation: fiveHour, resetsAt: "2026-09-30T14:00:00.000Z", verdict: null, observedAt },
    { window: "seven_day", utilisation: week, resetsAt: null, verdict: null, observedAt },
  ],
  readAt: observedAt,
  unavailableReason: null,
});

describe("Accounts", () => {
  it("lists the picked environment's accounts from accounts.list, each with its label, identity, status, plan reading and directory", async () => {
    const app = await opened({
      desk: {
        accounts: [
          { label: "personal", identity: MILO },
          { label: "work", directory: { kind: "owned", path: "/home/milo/.agent-harness/accounts/2" }, status: { state: "unreadable", checkedAt: null, detail: "auth status timed out after 10 s" } },
        ],
      },
      laptop: { accounts: [{ label: "laptop milo", identity: MILO }] },
    });
    app.environment("desk").setUsage([reading("account-1", 0.42, 0.1)]);
    const accounts = await openRow(app, "Accounts");

    const personal = await within(accounts).findByRole("region", { name: "personal" });
    await waitFor(() => expect(facts(personal)["Plan"]).toBe("5hr 42% · Week 10%"));
    expect(facts(personal)).toEqual({
      Identity: "milo@example.test",
      Status: "signed in",
      Plan: "5hr 42% · Week 10%",
      Directory: "/home/milo/.account-1, adopted in place",
    });
    expect(facts(within(accounts).getByRole("region", { name: "work" }))).toEqual({
      Identity: "not read yet",
      Status: "status unreadable: auth status timed out after 10 s",
      Plan: "no reading yet",
      Directory: "/home/milo/.agent-harness/accounts/2, the environment's own",
    });

    const laptop = await openRow(app, "Accounts", "laptop");
    expect(await within(laptop).findByRole("region", { name: "laptop milo" })).toBeDefined();
    expect(within(laptop).queryByRole("region", { name: "personal" })).toBeNull();
    // The accounts' status is read again as the pane opens on each environment.
    await waitFor(() => expect(app.environment("laptop").requests("accounts.refresh")).toHaveLength(1));
    expect(app.environment("desk").requests("accounts.refresh")).toHaveLength(1);

    // Carry over lives on this row beside Account: its step's link opens the full checklist on its card.
    await app.user.click(within(laptop).getByRole("button", { name: "Open the Carry over step in Set up" }));
    expect(within(screen.getByRole("region", { name: "Set up" })).getByRole("region", { name: "Carry over" })).toBeDefined();
  });

  it("offers the Claude Code sign-in on the environment's machine from accounts.probe, adopts it with accounts.adopt, and says a refusal in one line", async () => {
    const app = await opened({ desk: { accounts: [{ label: "work", directory: { kind: "owned", path: "/home/milo/.agent-harness/accounts/1" } }], ambient: { present: true, signedIn: true, identity: MILO } } });
    const desk = app.environment("desk");
    const accounts = await openRow(app, "Accounts");
    const offer = await within(accounts).findByRole("region", { name: "Use the Claude Code sign-in on desk's machine (milo@example.test)" });
    const label = within(offer).getByRole("textbox", { name: "Label (the email it signs in as when empty)" });

    await app.user.type(label, "WORK");
    await app.user.click(within(offer).getByRole("button", { name: "Adopt" }));
    expect(await within(accounts).findByText("Not adopted: The label WORK is taken by another account on this environment, ignoring case.")).toBeDefined();
    expect(desk.requests("accounts.adopt")[0]?.params).toMatchObject({ label: "WORK" });

    // Left empty, the account takes the email it signs in as; the offer goes once the directory is held.
    await app.user.clear(label);
    await app.user.click(within(offer).getByRole("button", { name: "Adopt" }));
    expect(await within(accounts).findByText("Adopted milo@example.test on desk.")).toBeDefined();
    expect(desk.requests("accounts.adopt")[1]?.params).not.toHaveProperty("label");
    const adopted = await within(accounts).findByRole("region", { name: "milo@example.test" });
    expect(facts(adopted)).toMatchObject({ Identity: "milo@example.test", Status: "signed in", Directory: "/home/milo/.claude, adopted in place" });
    await waitFor(() => expect(within(accounts).queryByRole("region", { name: /^Use the Claude Code sign-in/ })).toBeNull());
    expect(within(accounts).getAllByText(/^(Not adopted|Adopted)/)).toHaveLength(1);
  });

  it("adds an account and signs it in on the sign-in card, and signs in again an account whose sign-in lapsed, each end said in one line", async () => {
    const app = await opened({ desk: { accounts: [{ label: "work", identity: MILO, status: { state: "expired", checkedAt: null, detail: null } }] } });
    const desk = app.environment("desk");
    const accounts = await openRow(app, "Accounts");
    await app.user.click(within(accounts).getByRole("button", { name: "Add an account…" }));
    const adding = await screen.findByRole("dialog", { name: "Add an account on desk" });
    await app.user.type(within(adding).getByRole("textbox", { name: "Label for the new account" }), "personal{Enter}");
    const signing = await screen.findByRole("dialog", { name: "Sign in: personal on desk" });
    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=for-tests" });
    await app.user.type(await within(signing).findByRole("textbox", { name: "Then paste the code it shows" }), "code-for-tests{Enter}");
    await waitFor(() => expect(desk.requests("accounts.signin.code").map((request) => request.params)).toEqual([expect.objectContaining({ accountId: "account-2", code: "code-for-tests" })]));
    desk.signIn("done");
    expect(await within(accounts).findByText("personal is signed in on desk.")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Sign in: personal on desk" })).toBeNull();
    await waitFor(async () => expect(facts(await within(accounts).findByRole("region", { name: "personal" }))["Status"]).toBe("signed in"));

    const work = within(accounts).getByRole("region", { name: "work" });
    await app.user.click(within(work).getByRole("button", { name: "Sign in again" }));
    const again = await screen.findByRole("dialog", { name: "Sign in: work on desk" });
    await waitFor(() => expect(desk.requests("accounts.signin.start").map((request) => request.params)).toEqual([expect.objectContaining({ accountId: "account-1" })]));
    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=again" });
    await within(again).findByRole("textbox", { name: "Then paste the code it shows" });
    await app.user.click(within(again).getByRole("button", { name: "Cancel the sign-in" }));
    expect(await within(accounts).findByText("The sign-in of work was cancelled.")).toBeDefined();
    expect(within(accounts).queryByText("personal is signed in on desk.")).toBeNull();
  });

  it("relabels one with accounts.relabel, says a refusal in one line, and shows at once a relabel another client made", async () => {
    const app = await opened({ desk: { accounts: [{ label: "personal" }, { label: "work" }] } });
    const desk = app.environment("desk");
    const accounts = await openRow(app, "Accounts");
    const personal = await within(accounts).findByRole("region", { name: "personal" });
    const label = within(personal).getByRole("textbox", { name: "Label" });
    expect((label as HTMLInputElement).value).toBe("personal");
    expect(within(personal).getByRole("button", { name: "Relabel" }).hasAttribute("disabled")).toBe(true);

    await app.user.clear(label);
    await app.user.type(label, "Work");
    await app.user.click(within(personal).getByRole("button", { name: "Relabel" }));
    expect(await within(accounts).findByText("Not relabelled: The label Work is taken by another account on this environment, ignoring case.")).toBeDefined();

    await app.user.clear(label);
    await app.user.type(label, " home {Enter}");
    expect(await within(accounts).findByText("Relabelled personal to home.")).toBeDefined();
    expect(desk.requests("accounts.relabel").at(-1)?.params).toMatchObject({ accountId: "account-1", label: "home" });
    expect(await within(accounts).findByRole("region", { name: "home" })).toBeDefined();
    expect(desk.accounts().map((account) => account.label)).toEqual(["home", "work"]);

    // Another client's change reaches the pane through account.updated, the field following it.
    desk.changeAccount("account-2", { label: "office" });
    const office = await within(accounts).findByRole("region", { name: "office" });
    expect((within(office).getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("office");
    expect(within(accounts).queryByRole("region", { name: "work" })).toBeNull();
  });

  it("removes one with accounts.remove once confirmed, deleting an owned directory only when asked, and says a refusal in one line", async () => {
    const app = await opened({ desk: { accounts: [{ label: "personal" }, { label: "work", directory: { kind: "owned", path: "/home/milo/.agent-harness/accounts/2" } }, { label: "spare" }] } });
    const desk = app.environment("desk");
    const accounts = await openRow(app, "Accounts");

    // An owned directory: kept unless its deletion is ticked. Cancel sends nothing.
    await app.user.click(within(await within(accounts).findByRole("region", { name: "work" })).getByRole("button", { name: "Remove…" }));
    let asking = await screen.findByRole("dialog", { name: "Remove work from desk?" });
    expect(within(asking).getByText("Its directory, /home/milo/.agent-harness/accounts/2, stays unless you delete it too, with its sign-in and history.")).toBeDefined();
    await app.user.click(within(asking).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Remove work from desk?" })).toBeNull();
    expect(desk.requests("accounts.remove")).toEqual([]);

    await app.user.click(within(within(accounts).getByRole("region", { name: "work" })).getByRole("button", { name: "Remove…" }));
    asking = await screen.findByRole("dialog", { name: "Remove work from desk?" });
    await app.user.click(within(asking).getByRole("checkbox", { name: "Also delete its sign-in and history" }));
    await app.user.click(within(asking).getByRole("button", { name: "Remove" }));
    expect(await within(accounts).findByText("Removed work from desk and deleted its sign-in and history.")).toBeDefined();
    expect(desk.requests("accounts.remove")[0]?.params).toMatchObject({ accountId: "account-2", deleteDirectory: true });
    await waitFor(() => expect(within(accounts).queryByRole("region", { name: "work" })).toBeNull());

    // An adopted directory is the machine's own: never deleted, so nothing asks.
    await app.user.click(within(within(accounts).getByRole("region", { name: "personal" })).getByRole("button", { name: "Remove…" }));
    asking = await screen.findByRole("dialog", { name: "Remove personal from desk?" });
    expect(within(asking).getByText("Its directory, /home/milo/.account-1, is the machine's own Claude Code directory, adopted in place: removing the account leaves it as it is.")).toBeDefined();
    expect(within(asking).queryByRole("checkbox")).toBeNull();
    await app.user.click(within(asking).getByRole("button", { name: "Remove" }));
    expect(await within(accounts).findByText("Removed personal from desk; its directory stays at /home/milo/.account-1.")).toBeDefined();
    expect(desk.requests("accounts.remove")[1]?.params).not.toHaveProperty("deleteDirectory");

    // One another client removed while this one asked: the environment's refusal, in one line.
    await app.user.click(within(within(accounts).getByRole("region", { name: "spare" })).getByRole("button", { name: "Remove…" }));
    asking = await screen.findByRole("dialog", { name: "Remove spare from desk?" });
    desk.changeAccount("account-3", null);
    await app.user.click(within(asking).getByRole("button", { name: "Remove" }));
    expect(await within(accounts).findByText("Not removed: No account account-3 on this environment.")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Remove spare from desk?" })).toBeNull();
    expect(desk.accounts()).toEqual([]);
  });

  it("is read-only without admin, with the capability's line said once, and shows an unreachable environment's accounts as last read, read-only", async () => {
    const app = await opened({
      laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"], accounts: [{ label: "laptop milo", identity: MILO }], ambient: { present: true, signedIn: true, identity: MILO } },
      desk: { accounts: [{ label: "personal" }] },
    });
    const laptop = await openRow(app, "Accounts", "laptop");
    expect(await within(laptop).findByText("Read-only: This client was paired with laptop without the admin scope.")).toBeDefined();
    expect(within(laptop).getAllByText(/^Read-only:/)).toHaveLength(1);
    const milo = await within(laptop).findByRole("region", { name: "laptop milo" });
    const offer = await within(laptop).findByRole("region", { name: /^Use the Claude Code sign-in/ });
    for (const control of [
      within(laptop).getByRole("button", { name: "Add an account…" }),
      within(offer).getByRole("button", { name: "Adopt" }),
      within(milo).getByRole("textbox", { name: "Label" }),
      within(milo).getByRole("button", { name: "Sign in again" }),
      within(milo).getByRole("button", { name: "Remove…" }),
    ]) {
      expect(control.hasAttribute("disabled"), control.textContent ?? "").toBe(true);
    }

    const accounts = await openRow(app, "Accounts", "desk");
    const personal = await within(accounts).findByRole("region", { name: "personal" });
    expect(within(personal).getByRole("button", { name: "Remove…" }).hasAttribute("disabled")).toBe(false);
    const desk = app.environment("desk");
    desk.discovery("nothing");
    desk.server.drop();
    expect(await within(accounts).findByText(/^Unreachable since \d\d:\d\d: its accounts as this window last read them, read-only\.$/)).toBeDefined();
    const cached = within(accounts).getByRole("region", { name: "personal" });
    expect(facts(cached)["Status"]).toBe("signed in");
    for (const name of ["Sign in again", "Remove…"]) expect(within(cached).getByRole("button", { name }).hasAttribute("disabled"), name).toBe(true);
    expect(within(accounts).getByRole("button", { name: "Add an account…" }).hasAttribute("disabled")).toBe(true);
    expect(within(accounts).queryByText(/^Read-only:/)).toBeNull();
  });
});

/** The models desk's two accounts can use: personal's two families, work's one. */
const MODELS: ScriptedEnvironment["models"] = [
  {
    accountId: "account-1",
    models: [
      { id: "claude-opus-5", family: "opus", tier: 3, efforts: ["low", "medium", "high", "xhigh"], label: "Claude Opus 5" },
      { id: "claude-sonnet-5", family: "sonnet", tier: 2, efforts: ["low", "medium", "high"], label: null },
    ],
  },
  { accountId: "account-2", models: [{ id: "claude-haiku-5", family: "haiku", tier: 1, efforts: [], label: null }] },
];

/** A picker's options, each as it reads, and the one chosen. */
const choices = (picker: HTMLElement) => ({
  options: within(picker)
    .getAllByRole("option")
    .map((option) => option.textContent),
  chosen: within(picker).getByRole("option", { selected: true }).textContent,
});

describe("Default account and model", () => {
  it("edits the default account, model family and effort from pickers fed by accounts.list and models.list, and the process idle time, each through settings.update", async () => {
    const app = await opened({ desk: { accounts: [{ label: "personal" }, { label: "work", status: { state: "signed-out", checkedAt: null, detail: null } }], models: MODELS } });
    const desk = app.environment("desk");
    const defaults = await openRow(app, "Default account and model");
    const account = await within(defaults).findByRole("combobox", { name: "Default account" });
    const family = within(defaults).getByRole("combobox", { name: "Model family" });
    const effort = within(defaults).getByRole("combobox", { name: "Effort" });
    await waitFor(() => expect(choices(account).options).toEqual(["The first account adopted or added", "personal", "work (signed out)"]));
    expect(choices(account).chosen).toBe("The first account adopted or added");
    await waitFor(() =>
      expect(choices(family).options).toEqual(["The account's strongest model", "opus: Claude Opus 5 (claude-opus-5)", "sonnet: claude-sonnet-5", "haiku: claude-haiku-5"]),
    );
    // With no family set, a run takes the strongest model, whose efforts these are.
    expect(choices(effort)).toEqual({ options: ["The model's own", "low", "medium", "high", "xhigh"], chosen: "The model's own" });

    await app.user.selectOptions(account, "work (signed out)");
    await waitFor(() => expect(desk.settings()["accounts.defaultAccount"]).toBe("account-2"));
    await app.user.selectOptions(family, "sonnet: claude-sonnet-5");
    await waitFor(() => expect(desk.settings()["accounts.defaultModelFamily"]).toBe("sonnet"));
    await waitFor(() => expect(choices(effort).options).toEqual(["The model's own", "low", "medium", "high"]));
    await app.user.selectOptions(effort, "high");
    await waitFor(() => expect(desk.settings()["accounts.defaultEffort"]).toBe("high"));
    const idle = within(within(defaults).getByRole("group", { name: "Stop idle agent processes after minutes" })).getByRole("textbox");
    expect((idle as HTMLInputElement).value).toBe("30");
    await app.user.clear(idle);
    await app.user.type(idle, "45{Enter}");
    await waitFor(() => expect(desk.settings()["providers.processIdleMinutes"]).toBe(45));

    expect(desk.requests("settings.update").map((request) => request.params["values"])).toEqual([
      { "accounts.defaultAccount": "account-2" },
      { "accounts.defaultModelFamily": "sonnet" },
      { "accounts.defaultEffort": "high" },
      { "providers.processIdleMinutes": 45 },
    ]);
    expect(choices(account).chosen).toBe("work (signed out)");

    // Back to what runs take with none set.
    await app.user.selectOptions(family, "The account's strongest model");
    await waitFor(() => expect(desk.settings()["accounts.defaultModelFamily"]).toBeNull());
  });

  it("names a value set that the pickers no longer offer, with what runs take instead", async () => {
    const app = await opened({
      desk: { accounts: [{ label: "personal" }], models: MODELS.slice(0, 1), settings: { "accounts.defaultAccount": "account-9", "accounts.defaultModelFamily": "gpt", "accounts.defaultEffort": "max" } },
    });
    const defaults = await openRow(app, "Default account and model");
    const account = await within(defaults).findByRole("combobox", { name: "Default account" });
    await waitFor(() => expect(choices(account).chosen).toBe("account-9 (no longer held: runs take the first account)"));
    expect(choices(within(defaults).getByRole("combobox", { name: "Model family" })).chosen).toBe("gpt (not offered: runs take the strongest model)");
    const effort = choices(within(defaults).getByRole("combobox", { name: "Effort" }));
    expect(effort).toEqual({ options: ["The model's own", "max (not offered: runs take the model's own)", "low", "medium", "high", "xhigh"], chosen: "max (not offered: runs take the model's own)" });
  });

  it("is read-only without admin with the capability's line, shows an unreachable environment's values as last read, and says a refused write in one line", async () => {
    const app = await opened({
      desk: { accounts: [{ label: "personal" }], models: MODELS.slice(0, 1), receipts: { "settings.update": { rejected: "invalid_params", message: "accounts.defaultEffort: an effort is a word." } } },
      laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"], accounts: [{ label: "laptop milo" }], settings: { "accounts.defaultEffort": "medium" } },
    });
    const laptop = await openRow(app, "Default account and model", "laptop");
    expect(await within(laptop).findByText("Read-only: This client was paired with laptop without the admin scope.")).toBeDefined();
    expect(within(laptop).getAllByText(/^Read-only:/)).toHaveLength(1);
    await waitFor(() => expect(choices(within(laptop).getByRole("combobox", { name: "Effort" })).chosen).toBe("medium (not offered: runs take the model's own)"));
    for (const name of ["Default account", "Model family", "Effort"]) expect(within(laptop).getByRole("combobox", { name }).hasAttribute("disabled"), name).toBe(true);
    expect(within(within(laptop).getByRole("group", { name: "Stop idle agent processes after minutes" })).getByRole("textbox").hasAttribute("disabled")).toBe(true);

    const desk = await openRow(app, "Default account and model", "desk");
    const effort = await within(desk).findByRole("combobox", { name: "Effort" });
    await waitFor(() => expect(choices(effort).options).toContain("high"));
    await app.user.selectOptions(effort, "high");
    expect(await within(desk).findByText("Not saved: accounts.defaultEffort: an effort is a word.")).toBeDefined();
    expect(within(desk).getAllByText(/^Not saved:/)).toHaveLength(1);

    const scripted = app.environment("laptop");
    scripted.discovery("nothing");
    scripted.server.drop();
    const cached = await openRow(app, "Default account and model", "laptop");
    expect(await within(cached).findByText(/^Unreachable since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    expect(choices(within(cached).getByRole("combobox", { name: "Effort" })).chosen).toBe("medium (not offered: runs take the model's own)");
    expect(within(cached).getByRole("combobox", { name: "Effort" }).hasAttribute("disabled")).toBe(true);
    expect(within(cached).queryByText(/^Read-only:/)).toBeNull();
  });
});

/** A gauge's windows, each as its row reads. */
const windows = (gauge: HTMLElement) =>
  within(within(gauge).getByRole("list", { name: "Windows" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

/** The accounts a gauge pools, each as its row reads. */
const pooled = (gauge: HTMLElement) =>
  within(within(gauge).getByRole("list", { name: "Accounts" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

describe("Usage", () => {
  it("shows every gauge pooled by account identity across every environment, with the accounts and environments in each, and an unreachable environment's readings as last read", async () => {
    const work: AccountIdentity = { provider: "claude", email: "work@example.test", organisation: "Example" };
    const app = await opened({
      desk: { accounts: [{ label: "personal", identity: MILO }, { label: "work", identity: work }, { label: "spare", status: { state: "signed-out", checkedAt: null, detail: null } }] },
      laptop: { accounts: [{ label: "laptop milo", identity: MILO }] },
    });
    const earlier = "2026-09-30T10:00:00.000Z";
    app.environment("desk").setUsage([
      reading("account-1", 0.42, 0.1, earlier),
      { accountId: "account-2", identity: work, windows: [{ window: "five_hour", utilisation: 0.95, resetsAt: null, verdict: "rejected", observedAt: earlier }], readAt: earlier, unavailableReason: null },
      { accountId: "account-3", identity: null, windows: [], readAt: earlier, unavailableReason: "The account is not signed in." },
    ]);
    // Read later on laptop: its windows are the pooled gauge's.
    app.environment("laptop").setUsage([reading("account-1", 0.5, 0.2, "2026-09-30T11:00:00.000Z")]);
    const usage = await openRow(app, "Usage");
    expect(within(usage).queryByRole("combobox", { name: "Environment" })).toBeNull();

    const milo = await within(usage).findByRole("region", { name: "milo@example.test" });
    await waitFor(() => expect(pooled(milo)).toEqual(["personal on desk", "laptop milo on laptop"]));
    expect(windows(milo)).toEqual([expect.stringMatching(/^5-hour 50%, resets \d\d:\d\d$/), "Week 20%"]);
    expect(windows(within(usage).getByRole("region", { name: "work@example.test" }))).toEqual(["5-hour 95% out"]);
    const unread = within(usage).getByRole("region", { name: "An account never read" });
    expect(pooled(unread)).toEqual(["spare on desk"]);
    expect(within(unread).getByText("The account is not signed in.")).toBeDefined();
    expect(
      within(usage)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["milo@example.test", "work@example.test", "An account never read"]);

    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(usage).findByText(/^laptop: Unreachable since \d\d:\d\d: its readings as this window last read them\.$/)).toBeDefined();
    expect(pooled(within(usage).getByRole("region", { name: "milo@example.test" }))).toEqual(["personal on desk", "laptop milo on laptop"]);
    expect(windows(within(usage).getByRole("region", { name: "milo@example.test" }))[1]).toBe("Week 20%");
  });

  it("says when no account has a plan reading yet", async () => {
    const app = await opened();
    const usage = await openRow(app, "Usage");
    expect(await within(usage).findByText("No account has a plan reading yet.")).toBeDefined();
  });
});
