import { act, screen, waitFor, within } from "@testing-library/react";
import { uuidv7 } from "@agent-harness/client-runtime";
import type { AccountIdentity } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Account card in Set up (setup-copy.md §5.1; ADR 0018; #575, #1842): one
 * question, how to sign in, with this computer's Claude Code sign-in
 * pre-selected while it is signed in, and Sign in with Claude always, which
 * adds `Claude account` with no label form and names it by its email once it
 * is signed in; a row per account with its label, email and state, Rename
 * and Remove… in its More options and its folder and plan in Details; the
 * defaults in the step's More options and their preset on the first sign-in;
 * and Continue held on first launch until an account is signed in. Driven
 * through the harness's full checklist, which a first launch opens on the
 * Account step, over one scripted environment, `desk`, this computer.
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

/** The part of the card's More options holding the defaults, the fold opened first if it is shut. */
const defaults = () => within(step()).getByRole("region", { name: "Default account and model" });

/** Opens the step's own More options, the last fold of that name on the card. */
const moreOptions = async (app: RenderedApp) => {
  const folds = within(step()).getAllByRole("button", { name: "More options" });
  const fold = folds.at(-1) as HTMLElement;
  if (fold.getAttribute("aria-expanded") !== "true") await app.user.click(fold);
};

/** The question the card asks. */
const question = () => within(step()).getByRole("group", { name: "How do you want to sign in?" });

/** Signs in on the sign-in dialog the card opened, with the code, and waits for it to close. */
const signInWithCode = async (app: RenderedApp, dialog: string) => {
  const desk = app.environment("desk");
  const signing = await screen.findByRole("dialog", { name: dialog });
  desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=for-tests" });
  await app.user.type(await within(signing).findByRole("textbox", { name: "Then paste the code it shows" }), "code-for-tests#for-tests{Enter}");
  desk.signIn("done");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
};

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
  it("asks how to sign in, with this computer's Claude Code sign-in pre-selected, and uses it with accounts.adopt, its email the label", async () => {
    // An environment with a second provider: the card draws Claude's parts alone until milestone 2 (ADR 0016).
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, providers: [{}, { provider: "codex", displayName: "Codex" }] });
    const desk = app.environment("desk");
    const choice = await within(step()).findByRole("radio", { name: "Use the Claude Code sign-in on this computer (milo@example.test)" });
    expect(choice.getAttribute("aria-checked")).toBe("true");
    expect(within(question()).getByRole("radio", { name: "Sign in with Claude" }).getAttribute("aria-checked")).toBe("false");
    expect(desk.requests("accounts.probe").length).toBeGreaterThan(0);
    expect(within(step()).queryByText(/codex|local model/i)).toBeNull();
    expect(within(step()).queryByRole("combobox", { name: /provider/i })).toBeNull();
    // No label is asked for first, and no folder path is shown.
    expect(within(step()).queryByRole("textbox")).toBeNull();
    expect(within(step()).queryByText(/\/home\/milo/)).toBeNull();

    await app.user.click(within(question()).getByRole("button", { name: "Use this sign-in" }));
    expect(await within(step()).findByText("milo@example.test is signed in.")).toBeDefined();
    expect(desk.requests("accounts.adopt").map((request) => request.params)).toEqual([{ commandId: expect.any(String) }]);
    const row = await within(step()).findByRole("region", { name: "milo@example.test" });
    expect(facts(row)).toEqual({ Email: "milo@example.test", Status: "Signed in" });
    expect(within(row).getByRole("button", { name: "Sign in again" })).toBeDefined();
    await waitFor(() => expect(within(step()).queryByRole("radio", { name: /^Use the Claude Code sign-in/ })).toBeNull());
    expect(within(question()).getByRole("button", { name: "Sign in with Claude" })).toBeDefined();
  });

  it("says Claude Code on this computer is signed out, and offers Sign in with Claude alone", async () => {
    await opened({ ambient: { present: true, signedIn: false } });
    expect(await within(step()).findByText("Claude Code is on this computer but not signed in. Sign in below instead.")).toBeDefined();
    expect(within(question()).queryByRole("radio")).toBeNull();
    expect(within(question()).queryByRole("button", { name: "Use this sign-in" })).toBeNull();
    expect(within(question()).getByRole("button", { name: "Sign in with Claude" })).toBeDefined();
  });

  it("with no Claude Code on this computer asks the question with Sign in with Claude alone, and says there is no account yet", async () => {
    await opened();
    expect(await within(question()).findByRole("button", { name: "Sign in with Claude" })).toBeDefined();
    expect(within(step()).queryByText(/Claude Code is on this computer/)).toBeNull();
    expect(within(step()).queryByRole("radio")).toBeNull();
    expect(within(step()).queryByText("No account is held here.")).toBeNull();
  });

  it("signs in with Claude with no label form: adds Claude account, then names it by its email once it is signed in", async () => {
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO } });
    const desk = app.environment("desk");
    await app.user.click(await within(question()).findByRole("radio", { name: "Sign in with Claude" }));
    await app.user.click(within(question()).getByRole("button", { name: "Sign in with Claude" }));
    expect(screen.queryByRole("textbox", { name: "Label for the new account" })).toBeNull();
    await waitFor(() => expect(desk.requests("accounts.add").map((request) => request.params)).toEqual([expect.objectContaining({ label: "Claude account" })]));
    await signInWithCode(app, "Sign in: Claude account on desk");
    desk.changeAccount("account-1", { identity: { provider: "claude", email: "work@example.test", organisation: null } });
    await waitFor(() => expect(desk.requests("accounts.relabel").map((request) => request.params)).toEqual([expect.objectContaining({ accountId: "account-1", label: "work@example.test" })]));
    const row = await within(step()).findByRole("region", { name: "work@example.test" });
    expect(facts(row)).toEqual({ Email: "work@example.test", Status: "Signed in" });
  });

  it.each(["Work", "Claude account 3"])("numbers the next Claude account, and keeps the chosen name %s instead of the email", async (chosen) => {
    const app = await opened({ accounts: [{ label: "Claude account", identity: MILO }] });
    const desk = app.environment("desk");
    await within(step()).findByRole("region", { name: "Claude account" });
    await app.user.click(within(question()).getByRole("button", { name: "Sign in with Claude" }));
    await waitFor(() => expect(desk.requests("accounts.add").map((request) => request.params["label"])).toEqual(["Claude account 2"]));
    const first = await screen.findByRole("dialog", { name: "Sign in: Claude account 2 on desk" });
    await app.user.click(within(first).getByRole("button", { name: "Cancel the sign-in" }));

    await moreOptions(app);
    await app.user.type(within(step()).getByRole("textbox", { name: "Label for the new account" }), chosen);
    await app.user.click(within(question()).getByRole("button", { name: "Sign in with Claude" }));
    await waitFor(() => expect(desk.requests("accounts.add").map((request) => request.params["label"])).toEqual(["Claude account 2", chosen]));
    await signInWithCode(app, `Sign in: ${chosen} on desk`);
    // The name typed is the one account's: the field is empty again for the next.
    expect((within(step()).getByRole("textbox", { name: "Label for the new account" }) as HTMLInputElement).value).toBe("");
    desk.changeAccount("account-3", { identity: { provider: "claude", email: "work@example.test", organisation: null } });
    await within(step()).findByRole("region", { name: chosen });
    expect(desk.requests("accounts.relabel")).toEqual([]);
  });

  it("keeps the generated name when the person explicitly confirms that same name with Rename", async () => {
    const app = await opened({ accounts: [{ label: "Claude account", nameByEmail: true, directory: { kind: "owned", path: "/accounts/new" }, identity: null, status: { state: "signed-out", checkedAt: null, detail: null } }] });
    const desk = app.environment("desk");
    const row = await within(step()).findByRole("region", { name: "Claude account" });
    const fold = within(row).getByRole("button", { name: "More options" });
    if (fold.getAttribute("aria-expanded") !== "true") await app.user.click(fold);
    await app.user.click(within(row).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(desk.requests("accounts.relabel")).toHaveLength(1));
    expect(desk.accounts()[0]?.nameByEmail).not.toBe(true);
    desk.changeAccount("account-1", { identity: MILO, status: { state: "signed-in", checkedAt: null, detail: null } });
    await waitFor(() => expect(facts(row)["Email"]).toBe(MILO.email));
    expect(desk.requests("accounts.relabel")).toHaveLength(1);
    expect(desk.accounts()[0]?.label).toBe("Claude account");
  });

  it("retries a rejected email rename on a later account update without closing the list", async () => {
    const app = await opened({ accounts: [{ label: "Claude account", nameByEmail: true, directory: { kind: "owned", path: "/accounts/new" }, identity: null, status: { state: "signed-out", checkedAt: null, detail: null } }] });
    const desk = app.environment("desk");
    let attempts = 0;
    desk.wire.answer("accounts.relabel", (params) => {
      attempts++;
      if (attempts === 1) return { result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "Another account is already called milo@example.test. Choose another name.", data: { reason: "label_taken" } } } } };
      const label = String(params["label"]);
      desk.changeAccount("account-1", { label });
      return { result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: { account: desk.accounts()[0] } } };
    });
    desk.changeAccount("account-1", { identity: MILO, status: { state: "signed-in", checkedAt: null, detail: null } });
    await waitFor(() => expect(attempts).toBe(1));
    // A round trip on the same wire waits for the first command's refusal before the next update.
    await act(async () => { await app.runtime.requests.call(desk.environmentId, "accounts.list", {}); });
    desk.changeAccount("account-1", { status: { state: "signed-in", checkedAt: app.clock.now().toISOString(), detail: null } });
    await within(step()).findByRole("region", { name: MILO.email });
    expect(attempts).toBe(2);
  });

  it("refuses a name typed in More options that an account cannot have before any sign-in starts", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    await within(question()).findByRole("button", { name: "Sign in with Claude" });
    await moreOptions(app);
    await app.user.type(within(step()).getByRole("textbox", { name: "Label for the new account" }), "x".repeat(201));
    await app.user.click(within(question()).getByRole("button", { name: "Sign in with Claude" }));
    expect((await within(step()).findByRole("alert")).textContent).toBe("Error: Use 200 characters or fewer.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(desk.requests("accounts.add")).toEqual([]);
  });

  it("shows each row's label, email and state, with Rename and Remove… in its More options and its folder and plan in Details", async () => {
    const app = await opened({ accounts: [{ label: "personal", identity: MILO, directory: { kind: "owned", path: "/data/accounts/personal" } }] });
    const desk = app.environment("desk");
    const row = await within(step()).findByRole("region", { name: "personal" });
    expect(facts(row)).toEqual({ Email: "milo@example.test", Status: "Signed in" });
    expect(within(row).queryByRole("button", { name: "Rename" })).toBeNull();
    expect(within(row).queryByText(/\/data\/accounts/)).toBeNull();

    await app.user.click(within(row).getByRole("button", { name: "Details" }));
    expect(within(row).getByText("Folder: /data/accounts/personal (made by agent-harness)")).toBeDefined();
    await app.user.click(within(row).getByRole("button", { name: "More options" }));
    const name = within(row).getByRole("textbox", { name: "Name" });
    await app.user.clear(name);
    await app.user.click(within(row).getByRole("button", { name: "Rename" }));
    expect(await within(row).findByText("Enter a name.")).toBeDefined();
    expect(desk.requests("accounts.relabel")).toEqual([]);
    await app.user.type(name, "Home");
    await app.user.click(within(row).getByRole("button", { name: "Rename" }));
    expect(await within(step()).findByText("Renamed personal to Home.")).toBeDefined();
    expect(within(await within(step()).findByRole("region", { name: "Home" })).getByRole("button", { name: "Remove…" })).toBeDefined();
  });

  it("holds Continue on first launch until an account is signed in, with Skip for now disabled, and the first account signed in with the code lets it go", async () => {
    const app = await opened({ accounts: [{ label: "work", status: { state: "signed-out", checkedAt: null, detail: null } }] });
    const next = () => within(step()).getByRole("button", { name: "Continue" });
    const work = await within(step()).findByRole("region", { name: "work" });
    expect(facts(work)).toMatchObject({ Status: "Signed out" });
    expect(next().hasAttribute("disabled")).toBe(true);
    expect(within(step()).getByText("Sign in to continue. Account is the one required step.")).toBeDefined();
    expect(within(step()).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(true);

    await app.user.click(within(work).getByRole("button", { name: "Sign in again" }));
    await signInWithCode(app, "Sign in: work on desk");
    expect(within(step()).getByText("work is signed in on desk.")).toBeDefined();
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
    await within(question()).findByRole("button", { name: "Sign in with Claude" });
    expect(within(step()).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(within(step()).getByText("Sign in to continue. Account is the one required step.")).toBeDefined();
  });

  it("is read-only without admin, with the capability's line said once", async () => {
    const app = await opened({
      scopes: ["read", "sessions:write", "runs:drive", "terminal"],
      accounts: [{ label: "personal", status: { state: "expired", checkedAt: null, detail: null } }],
      ambient: { present: true, signedIn: true, identity: MILO },
      models: MODELS,
    });
    const card = step();
    expect(await within(card).findByText(/^You can look but not change this\. /)).toBeDefined();
    const personal = await within(card).findByRole("region", { name: "personal" });
    expect(facts(personal)).toMatchObject({ Status: "Sign-in ran out" });
    await within(card).findByRole("radio", { name: /^Use the Claude Code sign-in/ });
    await app.user.click(within(personal).getByRole("button", { name: "More options" }));
    await moreOptions(app);
    await within(card).findByRole("button", { name: /^Default account:/ });
    for (const control of [
      within(question()).getByRole("button", { name: "Use this sign-in" }),
      within(personal).getByRole("button", { name: "Sign in again" }),
      within(personal).getByRole("button", { name: "Remove…" }),
      ...["Default account", "Model family", "Effort"].map((name) => within(card).getByRole("button", { name: new RegExp(`^${name}:`) })),
    ]) {
      expect(control.hasAttribute("disabled"), control.textContent ?? "").toBe(true);
    }
    expect(within(card).getAllByText(/^You can look but not change this\./)).toHaveLength(1);
  });

  it("signs in with Claude on the sign-in card: accounts.add, then the URL, the code and the fallback command, with the sign-in's ten-minute countdown", async () => {
    const app = await opened({ accounts: [{ label: "personal", identity: MILO }] });
    const desk = app.environment("desk");
    await app.user.click(within(question()).getByRole("button", { name: "Sign in with Claude" }));
    const signing = await screen.findByRole("dialog", { name: "Sign in: Claude account on desk" });
    expect(desk.requests("accounts.add").map((request) => request.params)).toEqual([expect.objectContaining({ label: "Claude account" })]);

    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=for-tests" });
    expect(await within(signing).findByText("https://claude.test/oauth/authorize?state=for-tests")).toBeDefined();
    expect(within(signing).getByText("CLAUDE_CONFIG_DIR='/home/milo/.agent-harness/accounts/2' claude auth login")).toBeDefined();
    expect(within(signing).getByRole("timer").textContent).toBe("10m 0s left to sign in.");
    act(() => app.clock.advance(61_000));
    await waitFor(() => expect(within(signing).getByRole("timer").textContent).toBe("8m 59s left to sign in."));

    await app.user.type(within(signing).getByRole("textbox", { name: "Then paste the code it shows" }), "code-for-tests#for-tests{Enter}");
    await waitFor(() => expect(desk.requests("accounts.signin.code").map((request) => request.params)).toEqual([expect.objectContaining({ accountId: "account-2", code: "code-for-tests#for-tests" })]));
    desk.signIn("done");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(step()).getByText("Claude account is signed in on desk.")).toBeDefined();
    await waitFor(() => expect(facts(within(step()).getByRole("region", { name: "Claude account" }))["Status"]).toBe("Signed in"));
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
    expect(await within(card).findByText("home was not signed in: A sign-in is already running for work; cancel it, or wait for it to end.")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Once it has ended, home's runs, until its Cancel.
    desk.signIn("cancelled");
    await app.user.click(within(within(step()).getByRole("region", { name: "home" })).getByRole("button", { name: "Sign in again" }));
    const signing = await screen.findByRole("dialog", { name: "Sign in: home on desk" });
    desk.signIn("awaiting-code", { url: "https://claude.test/oauth/authorize?state=home" });
    expect(await within(signing).findByRole("timer")).toBeDefined();
    await app.user.click(within(signing).getByRole("button", { name: "Cancel the sign-in" }));
    expect(await within(card).findByText("The sign-in of home was cancelled.")).toBeDefined();
    expect(desk.requests("accounts.signin.cancel").map((request) => request.params["accountId"])).toEqual(["account-2"]);
  });
});

describe("the Account card's defaults", () => {
  it("draws the default account, model family and effort in the step's More options, each written through settings.update", async () => {
    const app = await opened({ accounts: [{ label: "personal" }, { label: "work" }], models: MODELS });
    const desk = app.environment("desk");
    await within(step()).findByRole("region", { name: "work" });
    await moreOptions(app);
    await within(defaults()).findByRole("button", { name: /^Default account:/ });
    expect(within(step()).getByRole("region", { name: "work" }).compareDocumentPosition(defaults()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The idle time is the row's, not the step card's.
    expect(within(defaults()).queryByRole("group", { name: "Stop idle agent processes after minutes" })).toBeNull();

    await pickDefault(app, "Default account", "work not read yet");
    await waitFor(() => expect(desk.settings()["accounts.defaultAccount"]).toBe("account-2"));
    await pickDefault(app, "Model family", "claude-sonnet-5");
    await waitFor(() => expect(desk.settings()["accounts.defaultModelFamily"]).toBe("sonnet"));
    await pickDefault(app, "Effort", "Medium");
    await waitFor(() => expect(desk.settings()["accounts.defaultEffort"]).toBe("medium"));
    expect(writes(app)).toEqual([{ "accounts.defaultAccount": "account-2" }, { "accounts.defaultModelFamily": "sonnet" }, { "accounts.defaultEffort": "medium" }]);
  });

  it("says a preset settings.update refused as an alert, Error: before it, with the refusal under Details", async () => {
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, models: MODELS, receipts: { "settings.update": { rejected: "invalid_params", message: "accounts.defaultEffort: an effort is a word." } } });
    await within(step()).findByRole("radio", { name: /^Use the Claude Code sign-in/ });
    await app.user.click(within(question()).getByRole("button", { name: "Use this sign-in" }));
    const line = await within(step()).findByText("Choose a model for new sessions in More options.");
    expect(line.closest("[role]")?.getAttribute("role")).toBe("alert");
    expect(line.closest("[role]")?.textContent).toBe("Error: Choose a model for new sessions in More options.");
    expect(within(step()).getByText(/accounts\.defaultEffort: an effort is a word\./)).toBeDefined();
  });

  it("presets the family the first signed-in account's catalogue ranks highest at high effort when both are unset, once", async () => {
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, models: MODELS });
    const desk = app.environment("desk");
    await within(step()).findByRole("radio", { name: /^Use the Claude Code sign-in/ });
    await app.user.click(within(question()).getByRole("button", { name: "Use this sign-in" }));
    await waitFor(() => expect(writes(app)).toEqual([{ "accounts.defaultModelFamily": "opus", "accounts.defaultEffort": "high" }]));
    expect(await within(step()).findByText("New sessions will use Claude Opus 5 with high effort. You can change this in Settings.")).toBeDefined();
    await moreOptions(app);
    await within(defaults()).findByRole("button", { name: "Model family: Claude Opus 5" });
    expect(within(defaults()).getByRole("button", { name: "Effort: High" })).toBeDefined();

    // Back to unset by hand, then a second account signed in: the card wrote its preset once.
    await pickDefault(app, "Model family", "The account's strongest model");
    await pickDefault(app, "Effort", "The model's own");
    await waitFor(() => expect(desk.settings()["accounts.defaultEffort"]).toBeNull());
    await app.user.click(within(question()).getByRole("button", { name: "Sign in with Claude" }));
    await signInWithCode(app, "Sign in: Claude account on desk");
    expect(within(step()).getByText("Claude account is signed in on desk.")).toBeDefined();
    expect(writes(app)).toHaveLength(3);
  });

  it("never writes over a family or effort already set", async () => {
    const app = await opened({ ambient: { present: true, signedIn: true, identity: MILO }, models: MODELS, settings: { "accounts.defaultEffort": "medium" } });
    await within(step()).findByRole("radio", { name: /^Use the Claude Code sign-in/ });
    await app.user.click(within(question()).getByRole("button", { name: "Use this sign-in" }));
    expect(await within(step()).findByText("milo@example.test is signed in.")).toBeDefined();
    await within(step()).findByRole("region", { name: "milo@example.test" });
    await moreOptions(app);
    await within(defaults()).findByRole("button", { name: "Effort: Medium" });
    expect(writes(app)).toEqual([]);
  });

  it("presets nothing when an account was signed in already as the card opened: the preset is the first sign-in's", async () => {
    const app = await opened({ accounts: [{ label: "personal" }, { label: "work", status: { state: "signed-out", checkedAt: null, detail: null } }], models: MODELS });
    const desk = app.environment("desk");
    await within(step()).findByRole("region", { name: "work" });
    desk.changeAccount("account-2", { status: { state: "signed-in", checkedAt: null, detail: null } });
    await waitFor(() => expect(facts(within(step()).getByRole("region", { name: "work" }))["Status"]).toBe("Signed in"));
    expect(writes(app)).toEqual([]);
  });
});
