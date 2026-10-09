import { act, screen, waitFor, within } from "@testing-library/react";
import { uuidv7 } from "@agent-harness/client-runtime";
import type { AccountIdentity } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Account card in Set up (the Set up specification, "1. Account"; ADR
 * 0018; #575): this machine's Claude Code sign-in offered first, signing in
 * another account on the sign-in card, a row per account, the defaults
 * under the list and their preset on the first sign-in, and Continue held
 * on first launch until an account is signed in. Driven through the
 * harness's full checklist, which a first launch opens on the Account step,
 * over one scripted environment, `desk`, this machine's.
 */

/** Who milo signs in as. */
const MILO: AccountIdentity = { provider: "claude", email: "milo@example.test", organisation: null };

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The Account step's card. */
const step = () => within(checklist()).getByRole("region", { name: "Account" });

/** What a row says of its account, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

/** The models desk's accounts can use: the first's two families, the second's one. */
const MODELS: ScriptedEnvironment["models"] = [
  {
    accountId: "account-1",
    models: [
      { id: "claude-sonnet-5", family: "sonnet", tier: 2, efforts: ["low", "medium", "high"], label: null },
      { id: "claude-opus-5", family: "opus", tier: 3, efforts: ["low", "medium", "high", "xhigh"], label: "Claude Opus 5" },
    ],
  },
  { accountId: "account-2", models: [{ id: "claude-haiku-5", family: "haiku", tier: 1, efforts: [], label: null }] },
];

/** The part of the card under the list holding the defaults. */
const defaults = () => within(step()).getByRole("region", { name: "Default account and model" });

/** Choose a standing default through its staged popup. */
const pickDefault = async (app: RenderedApp, name: string, value: string) => {
  await app.user.click(await within(defaults()).findByRole("button", { name: new RegExp(`^${name}:`) }));
  const picker = await screen.findByLabelText("New-session defaults");
  await app.user.click(await within(picker).findByRole("menuitem", { name: value }));
  await app.user.keyboard("{Escape}");
};

/** What desk was asked to write, in order. */
const writes = (app: RenderedApp) => app.environment("desk").requests("settings.update").map((request) => request.params["values"]);

/** The full checklist on its first launch, on the Account step, desk as `given` scripts it. */
const opened = async (given: Partial<ScriptedEnvironment> = {}, options: RenderOptions = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given }] }, { firstLaunch: true, ...options });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

describe("the Account card in Set up", () => {
  it("asks accounts.probe and offers this machine's Claude Code sign-in first, then adopts it with accounts.adopt as a row with its label, identity, status and Sign in again", async () => {
    // An environment with a second provider: the card draws Claude's parts alone until milestone 2 (ADR 0016).
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, providers: [{}, { provider: "codex", displayName: "Codex" }] });
    const desk = app.environment("desk");
    const offer = await within(step()).findByRole("region", { name: "Use the Claude Code sign-in on desk's machine (milo@example.test)" });
    expect(desk.requests("accounts.probe").length).toBeGreaterThan(0);
    expect(within(step()).queryByText(/codex|local model/i)).toBeNull();
    expect(within(step()).queryByRole("combobox", { name: /provider/i })).toBeNull();
    // This machine's sign-in comes first, then Sign in another account.
    const another = within(step()).getByRole("button", { name: "Sign in an account" });
    expect(offer.compareDocumentPosition(another) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await app.user.click(within(offer).getByRole("button", { name: "Adopt" }));
    expect(await within(step()).findByText("Adopted milo@example.test on desk.")).toBeDefined();
    expect(desk.requests("accounts.adopt")).toHaveLength(1);
    const row = await within(step()).findByRole("region", { name: "milo@example.test" });
    expect(facts(row)).toMatchObject({ Identity: "milo@example.test", Status: "signed in" });
    expect(within(row).getByRole("button", { name: "Sign in again" })).toBeDefined();
    await waitFor(() => expect(within(step()).queryByRole("region", { name: /^Use the Claude Code sign-in/ })).toBeNull());
  });

  it("holds Continue on first launch until an account is signed in, with Skip for now disabled, and the first account signed in with the code lets it go", async () => {
    const app = await opened({ accounts: [{ label: "work", status: { state: "signed-out", checkedAt: null, detail: null } }] });
    const desk = app.environment("desk");
    const next = () => within(step()).getByRole("button", { name: "Continue" });
    const work = await within(step()).findByRole("region", { name: "work" });
    expect(next().hasAttribute("disabled")).toBe(true);
    expect(within(step()).getByText("Sign in to continue. Account is the one required step.")).toBeDefined();
    expect(within(step()).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(true);

    await app.user.click(within(work).getByRole("button", { name: "Sign in again" }));
    const signing = await screen.findByRole("dialog", { name: "Sign in to Claude" });
    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=for-tests" });
    await app.user.click(await within(signing).findByRole("button", { name: "The page did not open?" }));
    await app.user.type(within(signing).getByRole("textbox", { name: "Code" }), "code-for-tests#for-tests{Enter}");
    desk.signIn("done");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(step()).getByText("work is signed in.")).toBeDefined();
    await waitFor(() => expect(next().hasAttribute("disabled")).toBe(false));
    expect(within(step()).queryByText("Sign in to continue. Account is the one required step.")).toBeNull();
    expect(within(step()).getByText("Account is the one required step.")).toBeDefined();
    await app.user.click(next());
    expect(within(checklist()).getByRole("region", { name: "Carry over" })).toBeDefined();
  });

  it("holds Continue for an unsigned account when the checklist is opened again", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await screen.findByText("No session is open. Choose one from the sidebar.");
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Open Set up" }));
    await within(step()).findByText("No account is held here.");
    expect(within(step()).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(within(step()).getByText("Sign in to continue. Account is the one required step.")).toBeDefined();
  });

  it("is read-only without admin, with the capability's line said once", async () => {
    await opened({
      scopes: ["read", "sessions:write", "runs:drive", "terminal"],
      accounts: [{ label: "personal", status: { state: "expired", checkedAt: null, detail: null } }],
      ambient: { present: true, signedIn: true, identity: MILO },
      models: MODELS,
    });
    const card = step();
    expect(await within(card).findByText(/^Read-only: /)).toBeDefined();
    const personal = await within(card).findByRole("region", { name: "personal" });
    const offer = await within(card).findByRole("region", { name: /^Use the Claude Code sign-in/ });
    await within(card).findByRole("button", { name: /^Default account:/ });
    for (const control of [
      within(card).getByRole("button", { name: "Sign in another account" }),
      within(offer).getByRole("button", { name: "Adopt" }),
      within(personal).getByRole("button", { name: "Sign in again" }),
      within(personal).getByRole("button", { name: "Remove…" }),
      ...["Default account", "Model family", "Effort"].map((name) => within(card).getByRole("button", { name: new RegExp(`^${name}:`) })),
    ]) {
      expect(control.hasAttribute("disabled"), control.textContent ?? "").toBe(true);
    }
    expect(within(card).getAllByText(/^Read-only:/)).toHaveLength(1);
  });

  it("signs in another account: a label, accounts.add, then the steps, the code and the terminal command, with the sign-in's ten-minute countdown", async () => {
    const app = await opened({ accounts: [{ label: "personal", identity: MILO }] });
    const desk = app.environment("desk");
    const card = step();
    await app.user.click(within(card).getByRole("button", { name: "Sign in another account" }));
    const adding = await screen.findByRole("dialog", { name: "Add an account on desk" });
    await app.user.type(within(adding).getByRole("textbox", { name: "Label for the new account" }), "work{Enter}");
    const signing = await screen.findByRole("dialog", { name: "Sign in to Claude" });
    expect(desk.requests("accounts.add").map((request) => request.params)).toEqual([expect.objectContaining({ label: "work" })]);

    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=for-tests" });
    await app.user.click(await within(signing).findByRole("button", { name: "The page did not open?" }));
    expect(signing.textContent).not.toContain("https://claude.test/oauth/authorize?state=for-tests");
    await app.user.click(within(signing).getByRole("button", { name: "Sign in from a terminal instead" }));
    expect(within(signing).getByText("CLAUDE_CONFIG_DIR='/home/milo/.agent-harness/accounts/2' claude auth login")).toBeDefined();
    expect(within(signing).getByRole("timer").textContent).toBe("10 min left");
    act(() => app.clock.advance(61_000));
    await waitFor(() => expect(within(signing).getByRole("timer").textContent).toBe("9 min left"));
    act(() => app.clock.advance(8 * 60_000));
    await waitFor(() => expect(within(signing).getByRole("timer").textContent).toBe("Less than a minute left."));

    await app.user.type(within(signing).getByRole("textbox", { name: "Code" }), "code-for-tests#for-tests{Enter}");
    await waitFor(() => expect(desk.requests("accounts.signin.code").map((request) => request.params)).toEqual([expect.objectContaining({ accountId: "account-2", code: "code-for-tests#for-tests" })]));
    desk.signIn("done");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(step()).getByText("work is signed in.")).toBeDefined();
    await waitFor(() => expect(facts(within(step()).getByRole("region", { name: "work" }))["Status"]).toBe("signed in"));
  });

  it("runs one sign-in at a time: a second start's refusal names the account holding the sign-in in one line, and Cancel ends the card's own", async () => {
    const app = await opened({
      accounts: [
        { label: "work", status: { state: "signed-out", checkedAt: null, detail: null } },
        { label: "home", status: { state: "expired", checkedAt: null, detail: null } },
      ],
    });
    const desk = app.environment("desk");
    const card = step();
    // work's sign-in, started by another client and running.
    await app.runtime.requests.call(desk.environmentId, "accounts.signin.start", { commandId: uuidv7(app.clock.now()), accountId: "account-1" });

    await app.user.click(within(within(card).getByRole("region", { name: "home" })).getByRole("button", { name: "Sign in again" }));
    expect(await within(card).findByText("Another sign-in is running for work. Finish or cancel it first.")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Once it has ended, home's runs, until its Cancel.
    desk.signIn("cancelled");
    await app.user.click(within(within(step()).getByRole("region", { name: "home" })).getByRole("button", { name: "Sign in again" }));
    const signing = await screen.findByRole("dialog", { name: "Sign in to Claude" });
    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=home" });
    expect(await within(signing).findByRole("timer")).toBeDefined();
    await app.user.click(within(signing).getByRole("button", { name: "Cancel the sign-in" }));
    expect(await within(card).findByText("The sign-in was cancelled.")).toBeDefined();
    expect(desk.requests("accounts.signin.cancel").map((request) => request.params["accountId"])).toEqual(["account-2"]);
  });
});

describe("the Account card's defaults", () => {
  it("draws the default account, model family and effort under the list, each written through settings.update", async () => {
    const app = await opened({ accounts: [{ label: "personal" }, { label: "work" }], models: MODELS });
    const desk = app.environment("desk");
    await within(defaults()).findByRole("button", { name: /^Default account:/ });
    expect(within(step()).getByRole("region", { name: "work" }).compareDocumentPosition(defaults()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The idle time is the row's, not the step card's.
    expect(within(defaults()).queryByRole("group", { name: "Stop idle agent processes after minutes" })).toBeNull();

    await pickDefault(app, "Default account", "work");
    await waitFor(() => expect(desk.settings()["accounts.defaultAccount"]).toBe("account-2"));
    await pickDefault(app, "Model family", "claude-sonnet-5");
    await waitFor(() => expect(desk.settings()["accounts.defaultModelFamily"]).toBe("sonnet"));
    await pickDefault(app, "Effort", "Medium");
    await waitFor(() => expect(desk.settings()["accounts.defaultEffort"]).toBe("medium"));
    expect(writes(app)).toEqual([{ "accounts.defaultAccount": "account-2" }, { "accounts.defaultModelFamily": "sonnet" }, { "accounts.defaultEffort": "medium" }]);
  });

  it("presets the family the first signed-in account's catalogue ranks highest at high effort when both are unset, once", async () => {
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, models: MODELS });
    const desk = app.environment("desk");
    const offer = await within(step()).findByRole("region", { name: /^Use the Claude Code sign-in/ });
    await app.user.click(within(offer).getByRole("button", { name: "Adopt" }));
    await waitFor(() => expect(writes(app)).toEqual([{ "accounts.defaultModelFamily": "opus", "accounts.defaultEffort": "high" }]));
    expect(await within(defaults()).findByText("Model family set to opus at high effort, the strongest milo@example.test offers.")).toBeDefined();
    await within(defaults()).findByRole("button", { name: "Model family: Claude Opus 5" });
    expect(within(defaults()).getByRole("button", { name: "Effort: High" })).toBeDefined();

    // Back to unset by hand, then a second account signed in: the card wrote its preset once.
    await pickDefault(app, "Model family", "The account's strongest model");
    await pickDefault(app, "Effort", "The model's own");
    await waitFor(() => expect(desk.settings()["accounts.defaultEffort"]).toBeNull());
    await app.user.click(within(step()).getByRole("button", { name: "Sign in another account" }));
    await app.user.type(within(await screen.findByRole("dialog", { name: "Add an account on desk" })).getByRole("textbox", { name: "Label for the new account" }), "work{Enter}");
    const signing = await screen.findByRole("dialog", { name: "Sign in to Claude" });
    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=for-tests" });
    await app.user.click(await within(signing).findByRole("button", { name: "The page did not open?" }));
    await app.user.type(within(signing).getByRole("textbox", { name: "Code" }), "code-for-tests#for-tests{Enter}");
    desk.signIn("done");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(step()).getByText("work is signed in.")).toBeDefined();
    expect(writes(app)).toHaveLength(3);
  });

  it("never writes over a family or effort already set", async () => {
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, models: MODELS, settings: { "accounts.defaultEffort": "medium" } });
    const offer = await within(step()).findByRole("region", { name: /^Use the Claude Code sign-in/ });
    await app.user.click(within(offer).getByRole("button", { name: "Adopt" }));
    expect(await within(step()).findByText("Adopted milo@example.test on desk.")).toBeDefined();
    await within(step()).findByRole("region", { name: "milo@example.test" });
    await within(defaults()).findByRole("button", { name: "Effort: Medium" });
    expect(writes(app)).toEqual([]);
  });

  it("presets nothing when an account was signed in already as the card opened: the preset is the first sign-in's", async () => {
    const app = await opened({ accounts: [{ label: "personal" }, { label: "work", status: { state: "signed-out", checkedAt: null, detail: null } }], models: MODELS });
    const desk = app.environment("desk");
    await within(step()).findByRole("region", { name: "work" });
    desk.changeAccount("account-2", { status: { state: "signed-in", checkedAt: null, detail: null } });
    await waitFor(() => expect(facts(within(step()).getByRole("region", { name: "work" }))["Status"]).toBe("signed in"));
    expect(writes(app)).toEqual([]);
  });
});
