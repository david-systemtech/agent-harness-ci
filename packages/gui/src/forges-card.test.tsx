import { screen, waitFor, within } from "@testing-library/react";
import { MANUAL_CLOCK_START, fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Forges card in Set up (the Set up specification, "4. Forges"; forge
 * spec, "The Forges step"; ADR 0020, ADR 0032, ADR 0033; #589): a row per
 * forge account with its origin and aliases, kind, login, primary star,
 * capabilities with their dots and its problem line with the action; Add a
 * forge from a pasted origin or repository URL, `forge.detect` naming its
 * kind, the token form deep-linking the token page with the scopes named;
 * this computer's `gh` on a remote environment and the environment's own
 * `gh` from `forge.gh.probe`; an alias verified before use; Make primary;
 * Move to your key manager on a stored token; no GitLab walkthrough or
 * expiry warning; and the card read-only without `admin`. Driven through
 * the harness's full checklist over the scripted environment's forge
 * answers and the fake shell's `gh`, in jsdom.
 */

/** A token as a person pastes one: nothing a secret scanner takes for a real one. */
const TOKEN = "token-for-tests";

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The Forges step's card. */
const step = () => within(checklist()).getByRole("region", { name: "Forges" });

/** A forge account's row on the card, by its origin, once it is drawn. */
const row = (origin: string) => within(step()).findByRole("region", { name: origin });

/** What a row says of its forge account, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

/** The rail's button for a step. */
const railStep = (name: string) => within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name });

/** The full checklist on its first launch over `desk`, this machine's environment offering forge, as `desk` scripts it, and the other environments given, showing the Forges step on the environment named. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}, others: readonly ScriptedEnvironment[] = [], options: { readonly on?: string; readonly shell?: FakeShell } = {}): Promise<RenderedApp> => {
  const app = await renderApp(
    { environments: [{ name: "desk", reach: "local", capabilities: ["forge"], ...desk }, ...others] },
    { firstLaunch: true, ...(options.shell !== undefined && { shell: options.shell }) },
  );
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  if (options.on !== undefined) await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Environment" }), options.on);
  await app.user.click(railStep("Forges"));
  return app;
};

/** Opens Add a forge on the card, and its inline group. */
const openAdd = async (app: RenderedApp, environment = "desk") => {
  await app.user.click(within(step()).getByRole("button", { name: "Add a forge" }));
  return screen.findByRole("region", { name: `Add a forge on ${environment}` });
};

describe("the Forges step's card", () => {
  it("is registered for the Forges step: where it stands, then a row per forge account", async () => {
    await opened({ forges: { accounts: [{}] } });
    expect(within(step()).getByRole("button", { name: "Open Forges" })).toBeDefined();
    expect(await row("https://github.com")).toBeDefined();
  });
});

describe("a forge account's row", () => {
  it("shows its origin and aliases, kind, login, primary star, capabilities with their dots, and its problem line", async () => {
    const at = MANUAL_CLOCK_START;
    await opened({
      forges: {
        accounts: [
          {},
          {
            origin: "https://git.example.test",
            kind: "forgejo",
            aliases: [
              { origin: "http://forge.tail.test:3000", verifiedAt: at },
              { origin: "http://forge.lan.test:3000", verifiedAt: null },
            ],
            capabilities: {
              readRepository: { state: "verified", verifiedAt: at, status: null },
              writeIssues: { state: "unknown", verifiedAt: null, status: null },
              pullRequests: { state: "failed", verifiedAt: null, status: 403 },
              createRepository: { state: "unknown", verifiedAt: null, status: null },
              readReleases: { state: "verified", verifiedAt: at, status: null },
            },
            problem: { kind: "unreachable", since: at, message: "https://git.example.test did not answer: check again once it is up." },
          },
        ],
      },
    });
    const github = await row("https://github.com");
    expect(facts(github)).toMatchObject({ Kind: "GitHub", "Signed in as": "david (user 42)" });
    expect(within(github).getByRole("img", { name: "Primary forge" })).toBeDefined();
    expect(within(github).queryByRole("button", { name: "Make primary" })).toBeNull();
    expect(within(github).queryByRole("list", { name: "Aliases" })).toBeNull();

    const forgejo = await row("https://git.example.test");
    expect(facts(forgejo)).toMatchObject({ Kind: "Forgejo", "Signed in as": "david (user 42)" });
    expect(within(forgejo).queryByRole("img", { name: "Primary forge" })).toBeNull();
    const aliases = within(within(forgejo).getByRole("list", { name: "Aliases" })).getAllByRole("listitem");
    expect(aliases.map((alias) => alias.textContent)).toEqual([
      expect.stringMatching(/^http:\/\/forge\.tail\.test:3000: last verified \d\d:\d\d$/),
      "http://forge.lan.test:3000: not verified yet, so not used until it answers as david",
    ]);
    const capabilities = within(forgejo).getByRole("list", { name: "Capabilities" });
    expect(within(capabilities).getAllByRole("img").map((dot) => dot.getAttribute("aria-label"))).toEqual([
      "Read repositories: verified",
      "Write issues: not tried yet",
      "Pull requests: refused (HTTP 403)",
      "Create repositories: not tried yet",
      "Read releases: verified",
    ]);
    expect(within(forgejo).getByText("https://git.example.test did not answer: check again once it is up.")).toBeDefined();
  });

  it("offers its problem's action: Check again verifies an unreachable one, Sign in again takes a new token in forge.accounts.update, a refusal in one line", async () => {
    const at = MANUAL_CLOCK_START;
    const app = await opened({
      forges: {
        rejects: ["token-refused-for-tests"],
        accounts: [
          { problem: { kind: "credential-rejected", since: at, message: "github.com refused the token (HTTP 401): give it a new one in Set up, Forges." }, statusSince: at },
          { origin: "https://git.example.test", kind: "forgejo", problem: { kind: "unreachable", since: at, message: "https://git.example.test did not answer." }, statusSince: at },
        ],
      },
    });
    const desk = app.environment("desk");
    const [github, forgejo] = desk.forgeAccounts();

    await app.user.click(within(await row("https://git.example.test")).getByRole("button", { name: "Check again" }));
    expect(await within(step()).findByText("Verified david on git.example.test.")).toBeDefined();
    expect(desk.requests("forge.accounts.verify").map((request) => request.params)).toEqual([{ forgeAccountId: forgejo?.id }]);
    await waitFor(async () => expect(within(await row("https://git.example.test")).queryByText("https://git.example.test did not answer.")).toBeNull());

    await app.user.click(within(await row("https://github.com")).getByRole("button", { name: "Sign in again" }));
    const form = within(await row("https://github.com")).getByRole("form", { name: "Sign in again to https://github.com" });
    expect(within(form).getByText(/^A fine-grained token with access to all repositories and Contents \(write\)/)).toBeDefined();
    expect(within(form).getByRole("button", { name: /^https:\/\/github\.com\/settings\/personal-access-tokens\/new/ })).toBeDefined();
    await app.user.type(within(form).getByLabelText("Token"), "token-refused-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Sign in again" }));
    expect(await within(form).findByText("Not signed in again: https://github.com refused the token (HTTP 401): nothing was stored.")).toBeDefined();
    expect((within(form).getByLabelText("Token") as HTMLInputElement).value).toBe("");

    await app.user.type(within(form).getByLabelText("Token"), TOKEN);
    await app.user.click(within(form).getByRole("button", { name: "Sign in again" }));
    expect(await within(step()).findByText("david on github.com is signed in again.")).toBeDefined();
    await waitFor(async () => expect(within(await row("https://github.com")).queryByText(/refused the token/)).toBeNull());
    expect(desk.requests("forge.accounts.update").map((request) => request.params)).toMatchObject([
      { forgeAccountId: github?.id, credential: { kind: "stored", provenance: "pasted", token: "token-refused-for-tests" } },
      { forgeAccountId: github?.id, credential: { kind: "stored", provenance: "pasted", token: TOKEN } },
    ]);
    expect(desk.forgeToken(github?.id ?? "")).toBe(TOKEN);
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain(TOKEN);
  });
});

describe("Add a forge", () => {
  it("takes a pasted origin or repository URL, forge.detect naming its kind, and the token form deep-links its token page with the scopes, sent in forge.accounts.add directly", async () => {
    const app = await opened();
    expect(await within(step()).findByText("No forge account is on this environment.")).toBeDefined();
    const add = await openAdd(app);
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://git.example.test/david/agent-harness.git");
    await app.user.click(within(add).getByRole("button", { name: "Find the forge" }));
    const found = await within(add).findByRole("region", { name: "The forge found" });
    expect(within(found).getByText("Forgejo at https://git.example.test, version 11.0.1+gitea-1.22.0.")).toBeDefined();
    const page = within(found).getByRole("button", { name: "https://git.example.test/user/settings/applications" });
    expect(within(found).getByText(/^An access token with /)).toBeDefined();
    await app.user.click(page);
    expect(app.shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", "https://git.example.test/user/settings/applications"]]);

    await app.user.type(within(add).getByLabelText("Token"), TOKEN);
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    expect(await within(step()).findByText("Added david on git.example.test.")).toBeDefined();
    expect(facts(await row("https://git.example.test"))).toMatchObject({ Kind: "Forgejo" });
    const desk = app.environment("desk");
    expect(desk.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([
      { url: "https://git.example.test/david/agent-harness.git", kind: "forgejo", credential: { kind: "stored", provenance: "pasted", token: TOKEN } },
    ]);
    // Sent directly, never through the outbox, and kept nowhere the client stores.
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain(TOKEN);
  });

  it("shows no GitLab walkthrough, and no expiry warning on a token the forge says expires", async () => {
    const expiresAt = new Date(Date.parse(MANUAL_CLOCK_START) + 10 * 86_400_000).toISOString();
    const expiring = { kind: "expiring" as const, since: MANUAL_CLOCK_START, message: "The token expires at 11 Oct 09:00: replace it in Set up, Forges before then." };
    const app = await opened({
      forges: { accounts: [{ tokenInformation: { kind: "fine-grained", scopes: null, expiresAt }, problem: expiring, statusSince: MANUAL_CLOCK_START }], detect: { "https://gitlab.com": "gitlab" } },
    });
    expect((await row("https://github.com")).textContent).not.toMatch(/expir/i);
    const add = await openAdd(app);
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://gitlab.com/david/agent-harness");
    await app.user.click(within(add).getByRole("button", { name: "Find the forge" }));
    expect(await within(add).findByText("The forge could not be told: https://gitlab.com is GitLab, which the harness cannot add a forge account for yet.")).toBeDefined();
    expect(within(add).queryByRole("region", { name: "The forge found" })).toBeNull();
    expect(within(add).queryByText(/api/)).toBeNull();
  });
});

describe("the gh paths", () => {
  it("on a remote environment, hands this computer's gh token over once with Use the gh signed in on this computer; never offered for this machine's own environment", async () => {
    const shell = fakeShell();
    shell.answer("gh.token", async (host) => (host === "github.com" ? "gh-token-for-tests" : undefined));
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: ["forge"] }], { on: "laptop", shell });
    const add = await openAdd(app, "laptop");
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://github.com/david/agent-harness");
    await app.user.click(within(add).getByRole("button", { name: "Use the gh signed in on this computer" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on laptop" })).toBeNull());
    expect(await row("https://github.com")).toBeDefined();
    const laptop = app.environment("laptop");
    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([["gh.token", "github.com"]]);
    expect(laptop.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([
      { url: "https://github.com/david/agent-harness", credential: { kind: "stored", provenance: "client-gh", token: "gh-token-for-tests" } },
    ]);
    expect(laptop.forgeAccounts()[0]?.credential).toMatchObject({ kind: "stored", provenance: "client-gh", followsGhRotations: false });
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain("gh-token-for-tests");

    // This machine's environment reads the same gh as its own: the hand-over is not offered there.
    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Environment" }), "desk");
    await app.user.click(railStep("Forges"));
    const onDesk = await openAdd(app);
    expect(within(onDesk).queryByRole("button", { name: "Use the gh signed in on this computer" })).toBeNull();
  });

  it("on a remote environment, is absent with its reason where the shell has no gh", async () => {
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: ["forge"] }], { on: "laptop", shell: { ...fakeShell(), gh: undefined } as unknown as FakeShell });
    const add = await openAdd(app, "laptop");
    expect(within(add).queryByRole("button", { name: "Use the gh signed in on this computer" })).toBeNull();
    expect(within(add).getByText("This app cannot use the gh tool signed in on this computer here. Add a token instead.")).toBeDefined();
  });

  it("on an environment with gh, Use this machine's gh adds the forge account with forge.gh.probe's login for the host, read on every use", async () => {
    const app = await opened({
      forges: {
        gh: {
          installed: true,
          version: "2.63.2",
          meetsMinimum: true,
          accounts: [
            { host: "github.com", login: "milo", active: false, tokenKind: "oauth", scopes: ["repo", "read:org"] },
            { host: "github.com", login: "david", active: true, tokenKind: "oauth", scopes: ["repo", "read:org"] },
          ],
        },
      },
    });
    const add = await openAdd(app);
    expect(await within(add).findByText("desk's own gh, read on every use, so it follows gh's rotations.")).toBeDefined();
    const desk = app.environment("desk");
    await waitFor(() => expect(desk.requests("forge.gh.probe").length).toBeGreaterThan(0));

    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://git.example.test");
    await app.user.click(within(add).getByRole("button", { name: "Use this machine's gh" }));
    expect(await within(add).findByText("Not added: The gh on desk is not signed in to git.example.test: run gh auth login --hostname git.example.test there, or paste a token.")).toBeDefined();
    expect(desk.requests("forge.accounts.add")).toEqual([]);

    await app.user.clear(within(add).getByRole("textbox", { name: "URL" }));
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "git@github.com:david/agent-harness.git");
    await app.user.click(within(add).getByRole("button", { name: "Use this machine's gh" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    expect(await row("https://github.com")).toBeDefined();
    expect(desk.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([{ url: "git@github.com:david/agent-harness.git", credential: { kind: "gh", login: "david" } }]);
    expect(desk.forgeAccounts()[0]?.credential).toEqual({ kind: "gh", login: "david" });
  });

  it("does not offer this machine's gh where forge.gh.probe finds none, or one older than the minimum, saying why", async () => {
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: ["forge"], forges: { gh: { installed: true, version: "2.30.0", meetsMinimum: false } } }]);
    const add = await openAdd(app);
    expect(await within(add).findByText("desk has no gh to read a token from.")).toBeDefined();
    expect(within(add).queryByRole("button", { name: "Use this machine's gh" })).toBeNull();
    await app.user.click(within(add).getByRole("button", { name: "Cancel" }));

    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Environment" }), "laptop");
    await app.user.click(railStep("Forges"));
    const onLaptop = await openAdd(app, "laptop");
    expect(await within(onLaptop).findByText("The gh on laptop is 2.30.0, older than 2.40.0, the oldest a forge account reads.")).toBeDefined();
    expect(within(onLaptop).queryByRole("button", { name: "Use this machine's gh" })).toBeNull();
  });
});

describe("aliases", () => {
  it("verifies an alias typed under a forge account before it is used, through forge.accounts.update, and says a refusal in one line", async () => {
    const app = await opened({
      forges: {
        accounts: [{}, { origin: "https://git.example.test", kind: "forgejo" }],
        aliases: { "http://forge.lan.test:3000": "unreachable", "http://other.tail.test:3000": "someone-else" },
      },
    });
    const desk = app.environment("desk");
    const [, forgejo] = desk.forgeAccounts();
    const field = async () => within(await row("https://git.example.test")).getByRole("form", { name: "Add an alias to https://git.example.test" });

    await app.user.type(within(await field()).getByRole("textbox", { name: "Alias" }), "http://forge.tail.test:3000/david/agent-harness.git");
    await app.user.click(within(await field()).getByRole("button", { name: "Add alias" }));
    expect(await within(step()).findByText("http://forge.tail.test:3000 answers as david: it is an alias of david on git.example.test.")).toBeDefined();
    const listed = async () => within(within(await row("https://git.example.test")).getByRole("list", { name: "Aliases" })).getAllByRole("listitem").map((alias) => alias.textContent);
    await waitFor(async () => expect(await listed()).toEqual([expect.stringMatching(/^http:\/\/forge\.tail\.test:3000: last verified \d\d:\d\d$/)]));
    expect((within(await field()).getByRole("textbox", { name: "Alias" }) as HTMLInputElement).value).toBe("");

    // One that does not answer waits unverified, and is not used until it does.
    await app.user.type(within(await field()).getByRole("textbox", { name: "Alias" }), "http://forge.lan.test:3000");
    await app.user.click(within(await field()).getByRole("button", { name: "Add alias" }));
    expect(await within(step()).findByText("http://forge.lan.test:3000 did not answer: it is not used until it answers as david.")).toBeDefined();
    await waitFor(async () => expect(await listed()).toHaveLength(2));
    expect((await listed())[1]).toBe("http://forge.lan.test:3000: not verified yet, so not used until it answers as david");

    // One answering as someone else is refused, in one line, and nothing changes.
    await app.user.type(within(await field()).getByRole("textbox", { name: "Alias" }), "http://other.tail.test:3000");
    await app.user.click(within(await field()).getByRole("button", { name: "Add alias" }));
    expect(
      await within(await field()).findByText(
        "Not added: http://other.tail.test:3000 answers the credential as other (user 7), not david (user 42): it is not the same forge. Nothing was changed.",
      ),
    ).toBeDefined();
    expect(await listed()).toHaveLength(2);
    expect(desk.requests("forge.accounts.update").map((request) => request.params)).toMatchObject([
      { forgeAccountId: forgejo?.id, aliases: ["http://forge.tail.test:3000"] },
      { forgeAccountId: forgejo?.id, aliases: ["http://forge.tail.test:3000", "http://forge.lan.test:3000"] },
      { forgeAccountId: forgejo?.id, aliases: ["http://forge.tail.test:3000", "http://forge.lan.test:3000", "http://other.tail.test:3000"] },
    ]);
    expect(desk.forgeAccounts()[1]?.aliases.map((alias) => alias.origin)).toEqual(["http://forge.tail.test:3000", "http://forge.lan.test:3000"]);

    // The alias refused stays in the field; one that is the forge account's own origin is refused before anything is sent.
    expect((within(await field()).getByRole("textbox", { name: "Alias" }) as HTMLInputElement).value).toBe("http://other.tail.test:3000");
    await app.user.clear(within(await field()).getByRole("textbox", { name: "Alias" }));
    await app.user.type(within(await field()).getByRole("textbox", { name: "Alias" }), "https://git.example.test/david");
    await app.user.click(within(await field()).getByRole("button", { name: "Add alias" }));
    expect(await within(await field()).findByText("Not added: https://git.example.test is the forge account's own origin.")).toBeDefined();
    expect(desk.requests("forge.accounts.update")).toHaveLength(3);
  });
});

describe("Make primary", () => {
  it("makes another forge account the primary, the star moving to it", async () => {
    const app = await opened({ forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo" }] } });
    const desk = app.environment("desk");
    const [, forgejo] = desk.forgeAccounts();
    await app.user.click(within(await row("https://git.example.test")).getByRole("button", { name: "Make primary" }));
    expect(await within(step()).findByText("david on git.example.test is the primary forge: new repositories go there unless another is named.")).toBeDefined();
    await waitFor(async () => expect(within(await row("https://git.example.test")).queryByRole("img", { name: "Primary forge" })).not.toBeNull());
    expect(within(await row("https://github.com")).getByRole("button", { name: "Make primary" })).toBeDefined();
    expect(desk.requests("forge.accounts.setPrimary").map((request) => request.params)).toMatchObject([{ forgeAccountId: forgejo?.id }]);
    expect(desk.forgeAccounts().map((account) => account.primary)).toEqual([false, true]);
  });
});

describe("Move to your key manager", () => {
  it("shows on a stored token's row alone, and opens the Key manager step's Move card", async () => {
    const app = await opened({
      capabilities: ["forge", "keyManagers", "managedTools"],
      forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo", credential: { kind: "gh", login: "david" } }] },
      keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }], items: [{ name: "https://github.com", slug: "github" }] },
    });
    // A token the environment's own gh reads holds nothing to move; a stored one does.
    expect(within(await row("https://git.example.test")).queryByRole("button", { name: "Move to your key manager" })).toBeNull();
    await app.user.click(within(await row("https://github.com")).getByRole("button", { name: "Move to your key manager" }));
    expect(railStep("Key manager").getAttribute("aria-current")).toBe("step");
    const keyManager = within(checklist()).getByRole("region", { name: "Key manager" });
    await waitFor(() => expect(document.activeElement).toBe(within(keyManager).getByRole("region", { name: "Move stored tokens" })));
    expect(await within(within(keyManager).getByRole("region", { name: "Move stored tokens" })).findByRole("listitem", { name: "https://github.com" })).toBeDefined();
  });
});

describe("without admin", () => {
  it("is read-only, saying the capability's line", async () => {
    await opened({}, [
      { name: "laptop", reach: "paired", capabilities: ["forge"], scopes: ["read", "sessions:write", "runs:drive", "terminal"], forges: { accounts: [{}, { origin: "https://git.example.test" }] } },
    ], { on: "laptop" });
    expect(await within(step()).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(step()).getByRole("button", { name: "Add a forge" }).hasAttribute("disabled")).toBe(true);
    const forgejo = await row("https://git.example.test");
    expect(within(forgejo).getByRole("button", { name: "Make primary" }).hasAttribute("disabled")).toBe(true);
    expect(within(forgejo).getByRole("textbox", { name: "Alias" }).hasAttribute("disabled")).toBe(true);
    expect(within(forgejo).getByRole("button", { name: "Add alias" }).hasAttribute("disabled")).toBe(true);
  });

  it("dims a problem's action that changes the forge account, and leaves the ways to the Key manager step, which change nothing", async () => {
    const at = MANUAL_CLOCK_START;
    const reference = { provider: "openbao", connectionId: "00000000-0000-4000-8000-000000000001", mount: "personal", path: "harness/forge-forgejo", key: "token" } as const;
    const app = await opened({}, [
      {
        name: "laptop",
        reach: "paired",
        capabilities: ["forge"],
        scopes: ["read", "sessions:write", "runs:drive", "terminal"],
        forges: {
          accounts: [
            { problem: { kind: "credential-rejected", since: at, message: "github.com refused the token (HTTP 401): give it a new one in Set up, Forges." }, statusSince: at },
            {
              origin: "https://git.example.test",
              kind: "forgejo",
              credential: { kind: "reference", reference },
              problem: { kind: "credential-unavailable", since: at, message: "The key manager did not give the token: open Set up, Key manager." },
              statusSince: at,
            },
          ],
        },
      },
    ], { on: "laptop" });
    expect(await within(step()).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    const github = await row("https://github.com");
    expect(within(github).getByRole("button", { name: "Sign in again" }).hasAttribute("disabled")).toBe(true);
    expect(within(github).getByRole("button", { name: "Move to your key manager" }).hasAttribute("disabled")).toBe(false);
    const forgejo = await row("https://git.example.test");
    expect(within(forgejo).getByRole("button", { name: "Open Key manager" }).hasAttribute("disabled")).toBe(false);
    await app.user.click(within(forgejo).getByRole("button", { name: "Open Key manager" }));
    expect(railStep("Key manager").getAttribute("aria-current")).toBe("step");
  });
});
