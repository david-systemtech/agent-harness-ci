import { act, screen, waitFor, within } from "@testing-library/react";
import { MANUAL_CLOCK_START, fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";
import { DETECT_PAUSE_MS } from "./forges/add-forge.js";

/**
 * The Forges card in Set up (the Set up specification, "4. Forges"; forge
 * spec, "The Forges step"; ADR 0020, ADR 0032, ADR 0033; #589): a row per
 * forge account with its origin and aliases, kind, login, primary star,
 * capabilities with their dots and its problem line with the action; Add a
 * forge from a pasted origin or repository URL, `forge.detect` naming its
 * kind, the token form deep-linking the token page with the scopes named;
 * this computer's `gh` on a remote environment and the environment's own
 * `gh` from `forge.gh.probe`; an alias verified before use; Make main;
 * Move to your key manager on a stored token; no GitLab walkthrough or
 * expiry warning; and the card read-only without `admin`. Driven through
 * the harness's full checklist over the scripted environment's forge
 * answers and the fake shell's `gh`, in jsdom.
 */

/** A token as a person pastes one: nothing a secret scanner takes for a real one. */
const TOKEN = "token-for-tests";

/** The add form's one address field (setup-copy.md §5.6). */
const ADDRESS = "Address of the site or of one of your repositories";

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
  if (options.on !== undefined) await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Setting up" }), options.on);
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
    expect(within(step()).getByRole("button", { name: "Open in Settings" })).toBeDefined();
    expect(await row("david on github.com")).toBeDefined();
  });
});

describe("a forge account's row", () => {
  it("reads setup-copy.md §5.6: login on host, Main forge or Make main, its state word, kind, what the token can do in words, its problem line with Details, and its other addresses under More options", async () => {
    const at = MANUAL_CLOCK_START;
    const app = await opened({
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
            problem: { kind: "unreachable", since: at, message: "git.example.test did not answer. Check the internet connection, then choose Check again.", details: ["GET /api/v1/user: connection refused"] },
          },
        ],
      },
    });
    const github = await row("david on github.com");
    expect(facts(github)).toMatchObject({ Kind: "GitHub" });
    expect(within(github).getByText("Main forge")).toBeDefined();
    expect(within(github).queryByRole("button", { name: "Make main" })).toBeNull();
    expect(within(github).getByText("Done")).toBeDefined();

    const forgejo = await row("david on git.example.test");
    expect(facts(forgejo)).toMatchObject({ Kind: "Forgejo" });
    expect(within(forgejo).queryByText("Main forge")).toBeNull();
    expect(within(forgejo).getByRole("button", { name: "Make main" })).toBeDefined();
    expect(within(forgejo).getByText("Needs a fix")).toBeDefined();
    // Each capability's state is visible words, never a tooltip or a status code alone.
    const capabilities = within(forgejo).getByRole("list", { name: "What the token can do" });
    expect(within(capabilities).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Read code: Works",
      "Write issues: Not checked yet",
      "Open pull requests: Not allowed",
      "Create repositories: Not checked yet",
      "Read releases: Works",
    ]);
    expect(forgejo.textContent).not.toContain("403");
    expect(within(forgejo).getByText("git.example.test did not answer. Check the internet connection, then choose Check again.")).toBeDefined();
    // The raw facts are under Details, not in the line.
    await app.user.click(within(forgejo).getByRole("button", { name: "Details" }));
    expect(within(forgejo).getByText(/GET \/api\/v1\/user: connection refused/)).toBeDefined();

    // Other addresses for this site sit in More options.
    expect(within(forgejo).queryByText("Other addresses for this site")).toBeNull();
    await app.user.click(within(forgejo).getByRole("button", { name: "More options" }));
    const others = within(forgejo).getByRole("region", { name: "Other addresses for this site" });
    expect(within(others).getAllByRole("listitem").map((alias) => alias.textContent)).toEqual([
      expect.stringMatching(/^http:\/\/forge\.tail\.test:3000: last verified \d\d:\d\d$/),
      "http://forge.lan.test:3000: not verified yet, so not used until it answers as david",
    ]);
  });

  it("offers its problem's action: Check again verifies an unreachable one, Add a new token takes one in forge.accounts.update under the token steps, a refusal in one plain line that keeps the token", async () => {
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

    await app.user.click(within(await row("david on git.example.test")).getByRole("button", { name: "Check again" }));
    expect(await within(step()).findByText("Verified david on git.example.test.")).toBeDefined();
    expect(desk.requests("forge.accounts.verify").map((request) => request.params)).toEqual([{ forgeAccountId: forgejo?.id }]);
    await waitFor(async () => expect(within(await row("david on git.example.test")).queryByText("https://git.example.test did not answer.")).toBeNull());

    await app.user.click(within(await row("david on github.com")).getByRole("button", { name: "Add a new token" }));
    const form = within(await row("david on github.com")).getByRole("form", { name: "A new token for david on github.com" });
    expect(within(form).getByText("1. Create a token on github.com.")).toBeDefined();
    expect(within(form).getByText(/^Give it these permissions: All repositories, with Contents: Read and write/)).toBeDefined();
    await app.user.click(within(form).getByRole("button", { name: "Create a token" }));
    expect(app.shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", expect.stringMatching(/^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?/)]]);
    await app.user.type(within(form).getByLabelText("Token"), "token-refused-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Add a new token" }));
    expect(await within(form).findByText("github.com did not accept this token. Check that you copied all of it, or create a new one.")).toBeDefined();
    expect(within(form).getByRole("alert").textContent).toBe("Error: github.com did not accept this token. Check that you copied all of it, or create a new one.");
    // What was typed stays after a refusal (setup-copy.md §1 rule 17).
    expect((within(form).getByLabelText("Token") as HTMLInputElement).value).toBe("token-refused-for-tests");

    await app.user.clear(within(form).getByLabelText("Token"));
    await app.user.type(within(form).getByLabelText("Token"), TOKEN);
    await app.user.click(within(form).getByRole("button", { name: "Add a new token" }));
    expect(await within(step()).findByText("david on github.com is signed in again.")).toBeDefined();
    await waitFor(async () => expect(within(await row("david on github.com")).queryByText(/refused the token/)).toBeNull());
    expect(desk.requests("forge.accounts.update").map((request) => request.params)).toMatchObject([
      { forgeAccountId: github?.id, credential: { kind: "stored", provenance: "pasted", token: "token-refused-for-tests" } },
      { forgeAccountId: github?.id, credential: { kind: "stored", provenance: "pasted", token: TOKEN } },
    ]);
    expect(desk.forgeToken(github?.id ?? "")).toBe(TOKEN);
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain(TOKEN);
  });
});

describe("Add a forge", () => {
  it("takes a site's or repository's address, forge.detect naming its kind, the numbered token steps opening its token page with the permissions in words, sent in forge.accounts.add directly", async () => {
    const app = await opened({ forges: { rejects: ["token-refused-for-tests"] } });
    expect(await within(step()).findByText("No forge account is on this environment.")).toBeDefined();
    const add = await openAdd(app);
    await app.user.type(within(add).getByRole("textbox", { name: ADDRESS }), "https://git.example.test/david/agent-harness.git");
    await app.user.click(within(add).getByRole("button", { name: "Check address" }));
    expect(await within(add).findByText("git.example.test runs Forgejo.")).toBeDefined();
    const steps = within(add).getByRole("list", { name: "Token steps" });
    expect(within(steps).getByText("1. Create a token on git.example.test.")).toBeDefined();
    expect(within(steps).getByText("Give it these permissions: User: Read, Repository: Read and write, Issue: Read and write and Organization: Read and write.")).toBeDefined();
    expect(within(steps).getByText("2. Paste the token here.")).toBeDefined();
    expect(within(steps).getByText("The token is kept on this computer, not in this window.")).toBeDefined();
    await app.user.click(within(steps).getByRole("button", { name: "Create a token" }));
    expect(app.shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", "https://git.example.test/user/settings/applications"]]);

    // A refused token is one plain line with Details, and stays typed.
    await app.user.type(within(add).getByLabelText("Token"), "token-refused-for-tests");
    await app.user.click(within(add).getByRole("button", { name: "Add git.example.test" }));
    expect(await within(add).findByText("git.example.test did not accept this token. Check that you copied all of it, or create a new one.")).toBeDefined();
    expect(within(add).getByRole("button", { name: "Details" })).toBeDefined();
    expect((within(add).getByLabelText("Token") as HTMLInputElement).value).toBe("token-refused-for-tests");

    await app.user.clear(within(add).getByLabelText("Token"));
    await app.user.type(within(add).getByLabelText("Token"), TOKEN);
    await app.user.click(within(add).getByRole("button", { name: "Add git.example.test" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    expect(await within(step()).findByText("david on git.example.test is connected.")).toBeDefined();
    expect(facts(await row("david on git.example.test"))).toMatchObject({ Kind: "Forgejo" });
    const desk = app.environment("desk");
    expect(desk.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([
      { url: "https://git.example.test/david/agent-harness.git", kind: "forgejo", credential: { kind: "stored", provenance: "pasted", token: "token-refused-for-tests" } },
      { url: "https://git.example.test/david/agent-harness.git", kind: "forgejo", credential: { kind: "stored", provenance: "pasted", token: TOKEN } },
    ]);
    // Sent directly, never through the outbox, and kept nowhere the client stores.
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain(TOKEN);
  });

  it("adds a self-hosted site detection cannot recognise with the kind the person chooses", async () => {
    const app = await opened({ forges: { detect: { "https://code.example.test": "not_a_forge" } } });
    const add = await openAdd(app);
    await app.user.type(within(add).getByRole("textbox", { name: ADDRESS }), "https://code.example.test/team/project");
    await app.user.click(within(add).getByRole("button", { name: "Check address" }));
    expect(await within(add).findByText("agent-harness does not recognise this site. Choose what it runs:")).toBeDefined();
    await app.user.click(within(add).getByRole("radio", { name: "Gitea" }));
    expect(within(add).getByText("1. Create a token on code.example.test.")).toBeDefined();
    await app.user.type(within(add).getByLabelText("Token"), TOKEN);
    await app.user.click(within(add).getByRole("button", { name: "Add code.example.test" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    const desk = app.environment("desk");
    expect(desk.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([{ url: "https://code.example.test/team/project", kind: "gitea" }]);
    expect(desk.forgeAccounts()[0]).toMatchObject({ origin: "https://code.example.test", kind: "gitea" });
  });

  it("finds the kind as the address is typed, and keeps the typed token when the kind changes or the address is checked again", async () => {
    const app = await opened({ forges: { detect: { "https://code.example.test": "not_a_forge" } } });
    const add = await openAdd(app);
    // Check address is never dimmed: pressed with nothing typed, it says what to enter.
    await app.user.click(within(add).getByRole("button", { name: "Check address" }));
    expect(within(add).getByText("Enter an address like https://github.com/you/project.")).toBeDefined();
    expect(app.environment("desk").requests("forge.detect")).toEqual([]);
    await app.user.type(within(add).getByRole("textbox", { name: ADDRESS }), "https://git.example.test/team/project");
    // No button pressed: the kind is found once typing pauses, and only then.
    act(() => app.clock.advance(DETECT_PAUSE_MS - 1));
    expect(app.environment("desk").requests("forge.detect")).toEqual([]);
    act(() => app.clock.advance(1));
    expect(await within(add).findByText("1. Create a token on git.example.test.")).toBeDefined();
    expect(app.environment("desk").requests("forge.detect").map((request) => request.params)).toEqual([{ url: "https://git.example.test/team/project" }]);
    await app.user.type(within(add).getByLabelText("Token"), TOKEN);
    await app.user.click(within(add).getByRole("button", { name: "Check address" }));
    await waitFor(() => expect(app.environment("desk").requests("forge.detect").length).toBeGreaterThanOrEqual(2));
    expect(await within(add).findByLabelText("Token")).toHaveProperty("value", TOKEN);

    await app.user.clear(within(add).getByRole("textbox", { name: ADDRESS }));
    await app.user.type(within(add).getByRole("textbox", { name: ADDRESS }), "https://code.example.test");
    act(() => app.clock.advance(DETECT_PAUSE_MS));
    await app.user.click(await within(add).findByRole("radio", { name: "Forgejo" }));
    await app.user.click(within(add).getByRole("radio", { name: "Gitea" }));
    expect(within(add).getByLabelText("Token")).toHaveProperty("value", TOKEN);
  });

  it("says an address that names no site in the field's words once typing pauses, asking nothing, and checks one on Enter before its kind is known", async () => {
    const app = await opened();
    const add = await openAdd(app);
    const field = within(add).getByRole("textbox", { name: ADDRESS });
    await app.user.type(field, "github.com/you/project");
    act(() => app.clock.advance(DETECT_PAUSE_MS));
    expect(await within(add).findByText("Enter an address like https://github.com/you/project.")).toBeDefined();
    expect(within(add).queryByText(/could not use what was sent/)).toBeNull();
    expect(app.environment("desk").requests("forge.detect")).toEqual([]);
    // Enter before the kind is known checks the address, as Check address does, rather than doing nothing.
    await app.user.clear(field);
    await app.user.type(field, "https://git.example.test/team/project{Enter}");
    expect(await within(add).findByText("1. Create a token on git.example.test.")).toBeDefined();
    // The pause the last keystroke started asks nothing more: the address is already checked, and the token steps stay as they are.
    const token = within(add).getByLabelText("Token");
    act(() => app.clock.advance(DETECT_PAUSE_MS));
    expect(within(add).queryByText("Checking…")).toBeNull();
    expect(within(add).getByLabelText("Token")).toBe(token);
    expect(app.environment("desk").requests("forge.detect").map((request) => request.params)).toEqual([{ url: "https://git.example.test/team/project" }]);
  });

  it("shows no GitLab walkthrough, and no expiry warning on a token the forge says expires", async () => {
    const expiresAt = new Date(Date.parse(MANUAL_CLOCK_START) + 10 * 86_400_000).toISOString();
    const expiring = { kind: "expiring" as const, since: MANUAL_CLOCK_START, message: "The token expires at 11 Oct 09:00: replace it in Set up, Forges before then." };
    const app = await opened({
      forges: { accounts: [{ tokenInformation: { kind: "fine-grained", scopes: null, expiresAt }, problem: expiring, statusSince: MANUAL_CLOCK_START }], detect: { "https://gitlab.com": "gitlab" } },
    });
    expect((await row("david on github.com")).textContent).not.toMatch(/expir|runs out/i);
    const add = await openAdd(app);
    await app.user.type(within(add).getByRole("textbox", { name: ADDRESS }), "https://gitlab.com/david/agent-harness");
    await app.user.click(within(add).getByRole("button", { name: "Check address" }));
    expect(await within(add).findByText("GitLab is not supported yet.")).toBeDefined();
    expect(within(add).queryByRole("list", { name: "Token steps" })).toBeNull();
    expect(within(add).queryByRole("radio")).toBeNull();
    expect(within(add).queryByText(/api/)).toBeNull();
  });
});

describe("the gh paths", () => {
  /** The gh paths, first on the card, before Add a forge. */
  const ghFirst = () => {
    const card = step();
    const add = within(card).getByRole("button", { name: "Add a forge" });
    return { card, before: (element: HTMLElement) => Boolean(element.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING) };
  };

  it("on a remote environment, comes first: Use the gh sign-in from this computer hands its token over once; never offered for this machine's own environment", async () => {
    const shell = fakeShell();
    shell.answer("gh.token", async (host) => (host === "github.com" ? "gh-token-for-tests" : undefined));
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: ["forge"] }], { on: "laptop", shell });
    const use = await within(step()).findByRole("button", { name: "Use the gh sign-in from this computer" });
    expect(ghFirst().before(use)).toBe(true);
    await app.user.click(use);
    expect(await within(step()).findByText("david on github.com is connected.")).toBeDefined();
    expect(await row("david on github.com")).toBeDefined();
    const laptop = app.environment("laptop");
    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([["gh.token", "github.com"]]);
    expect(laptop.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([
      { url: "https://github.com", credential: { kind: "stored", provenance: "client-gh", token: "gh-token-for-tests" } },
    ]);
    expect(laptop.forgeAccounts()[0]?.credential).toMatchObject({ kind: "stored", provenance: "client-gh", followsGhRotations: false });
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain("gh-token-for-tests");

    // This machine's environment reads the same gh as its own: the hand-over is not offered there.
    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Setting up" }), "desk");
    await app.user.click(railStep("Forges"));
    expect(within(step()).queryByRole("button", { name: "Use the gh sign-in from this computer" })).toBeNull();
  });

  it("on a remote environment, is absent with its reason where the shell has no gh", async () => {
    await opened({}, [{ name: "laptop", reach: "paired", capabilities: ["forge"] }], { on: "laptop", shell: { ...fakeShell(), gh: undefined } as unknown as FakeShell });
    expect(within(step()).queryByRole("button", { name: "Use the gh sign-in from this computer" })).toBeNull();
    expect(await within(step()).findByText("This app cannot use the gh tool signed in on this computer here. Add a token instead.")).toBeDefined();
  });

  it("on an environment with gh, comes first: Use gh with its login adds the forge account with forge.gh.probe's login, read on every use", async () => {
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
    expect(await within(step()).findByText("Use your GitHub sign-in from the gh tool (david)")).toBeDefined();
    const use = within(step()).getByRole("button", { name: "Use gh" });
    expect(ghFirst().before(use)).toBe(true);
    await app.user.click(use);
    expect(await row("david on github.com")).toBeDefined();
    const desk = app.environment("desk");
    expect(desk.requests("forge.accounts.add").map((request) => request.params)).toMatchObject([{ url: "https://github.com", credential: { kind: "gh", login: "david" } }]);
    expect(desk.forgeAccounts()[0]?.credential).toEqual({ kind: "gh", login: "david" });
  });

  it("offers Install gh in place where gh is missing, run in a tool terminal on the card, and never a second Install in the status line", async () => {
    const app = await opened({
      capabilities: ["forge", "managedTools"],
      managedTools: { runs: { gh: { command: "brew install gh" } } },
      setup: { forges: { state: "needs-attention", reason: "The gh tool is not installed. Install it to use your GitHub sign-in.", failing: ["forges.gh"], actions: ["install"], targets: [{ action: "install", kind: "tool", id: "gh", label: "gh" }] } },
    });
    expect(await within(step()).findAllByText("The gh tool is not installed. Install it to use your GitHub sign-in.")).not.toHaveLength(0);
    expect(within(step()).queryByRole("button", { name: "Install gh in a tool terminal" })).toBeNull();
    const install = within(step()).getByRole("button", { name: "Install gh" });
    expect(ghFirst().before(install)).toBe(true);
    await app.user.click(install);
    expect(await within(step()).findByRole("region", { name: "Installing GitHub CLI" })).toBeDefined();
    expect(app.environment("desk").requests("tools.run").map((request) => request.params)).toEqual([{ commandId: expect.any(String), id: expect.any(String), tool: "gh", action: "install" }]);
  });

  it("leaves Install gh in the status line, dimmed with its reason, where the list cannot draw it: a read-only grant", async () => {
    await opened({
      capabilities: ["forge", "managedTools"],
      scopes: ["read", "sessions:write", "runs:drive", "terminal"],
      managedTools: { runs: { gh: { command: "brew install gh" } } },
      setup: { forges: { state: "needs-attention", reason: "The gh tool is not installed. Install it to use your GitHub sign-in.", failing: ["forges.gh"], actions: ["install"], targets: [{ action: "install", kind: "tool", id: "gh", label: "gh" }] } },
    });
    expect(await within(step()).findAllByText("The gh tool is not installed. Install it to use your GitHub sign-in.")).not.toHaveLength(0);
    const install = within(step()).getByRole("button", { name: /^Install gh/ });
    expect(install.hasAttribute("disabled")).toBe(true);
    expect(install.closest("[data-gh-route]")).toBeNull();
  });

  it("offers Update gh where gh is older than the minimum, and how to sign it in or Add a token instead where it is signed in nowhere", async () => {
    const app = await opened({ forges: { gh: { installed: true, version: "2.30.0", meetsMinimum: false } } }, [
      { name: "laptop", reach: "paired", capabilities: ["forge"], forges: { gh: { installed: true, version: "2.63.2", meetsMinimum: true, accounts: [] } } },
    ]);
    expect(await within(step()).findByText("The gh tool is out of date.")).toBeDefined();
    expect(within(step()).getByRole("button", { name: "Update gh" })).toBeDefined();
    expect(within(step()).queryByRole("button", { name: "Use gh" })).toBeNull();

    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Setting up" }), "laptop");
    await app.user.click(railStep("Forges"));
    expect(await within(step()).findByText("The gh tool is not signed in to github.com. Run gh auth login on laptop, or add a token instead.")).toBeDefined();
    expect(within(step()).getByText("gh auth login --hostname github.com")).toBeDefined();
    await app.user.click(within(step()).getByRole("button", { name: "Add a token instead" }));
    expect(await screen.findByRole("region", { name: "Add a forge on laptop" })).toBeDefined();
  });
});

describe("other addresses for this site", () => {
  it("verifies another address typed under More options before it is used, through forge.accounts.update, and says a refusal in one plain line", async () => {
    const app = await opened({
      forges: {
        accounts: [{}, { origin: "https://git.example.test", kind: "forgejo" }],
        aliases: { "http://forge.lan.test:3000": "unreachable", "http://other.tail.test:3000": "someone-else" },
      },
    });
    const desk = app.environment("desk");
    const [, forgejo] = desk.forgeAccounts();
    await app.user.click(within(await row("david on git.example.test")).getByRole("button", { name: "More options" }));
    const field = async () => within(await row("david on git.example.test")).getByRole("form", { name: "Add another address for david on git.example.test" });
    const address = async () => within(await field()).getByRole("textbox", { name: "Another address for this site" });

    await app.user.type(await address(), "http://forge.tail.test:3000/david/agent-harness.git");
    await app.user.click(within(await field()).getByRole("button", { name: "Add address" }));
    expect(await within(step()).findByText("forge.tail.test:3000 is another address for david on git.example.test.")).toBeDefined();
    const others = async () => within(await row("david on git.example.test")).getByRole("region", { name: "Other addresses for this site" });
    const listed = async () => within(await others()).queryAllByRole("listitem").map((alias) => alias.textContent);
    await waitFor(async () => expect(await listed()).toEqual([expect.stringMatching(/^http:\/\/forge\.tail\.test:3000: last verified \d\d:\d\d$/)]));
    expect(((await address()) as HTMLInputElement).value).toBe("");

    // One that does not answer waits unverified, and is not used until it does.
    await app.user.type(await address(), "http://forge.lan.test:3000");
    await app.user.click(within(await field()).getByRole("button", { name: "Add address" }));
    expect(await within(step()).findByText("forge.lan.test:3000 did not answer. It is used once it answers as david.")).toBeDefined();
    await waitFor(async () => expect(await listed()).toHaveLength(2));
    expect((await listed())[1]).toBe("http://forge.lan.test:3000: not verified yet, so not used until it answers as david");

    // One answering as someone else is refused, in one plain line, and nothing changes.
    await app.user.type(await address(), "http://other.tail.test:3000");
    await app.user.click(within(await field()).getByRole("button", { name: "Add address" }));
    expect(await within(await field()).findByText("other.tail.test:3000 knows this token as another user, so it is not another address for this site. Nothing was changed.")).toBeDefined();
    expect(await listed()).toHaveLength(2);
    expect(desk.requests("forge.accounts.update").map((request) => request.params)).toMatchObject([
      { forgeAccountId: forgejo?.id, aliases: ["http://forge.tail.test:3000"] },
      { forgeAccountId: forgejo?.id, aliases: ["http://forge.tail.test:3000", "http://forge.lan.test:3000"] },
      { forgeAccountId: forgejo?.id, aliases: ["http://forge.tail.test:3000", "http://forge.lan.test:3000", "http://other.tail.test:3000"] },
    ]);
    expect(desk.forgeAccounts()[1]?.aliases.map((alias) => alias.origin)).toEqual(["http://forge.tail.test:3000", "http://forge.lan.test:3000"]);

    // The address refused stays in the field; the site's own address is refused before anything is sent.
    expect(((await address()) as HTMLInputElement).value).toBe("http://other.tail.test:3000");
    await app.user.clear(await address());
    await app.user.type(await address(), "https://git.example.test/david");
    await app.user.click(within(await field()).getByRole("button", { name: "Add address" }));
    expect(await within(await field()).findByText("git.example.test is this site's own address.")).toBeDefined();
    expect(desk.requests("forge.accounts.update")).toHaveLength(3);
  });
});

describe("Make main", () => {
  it("makes another forge account the main forge, the Main forge badge moving to it", async () => {
    const app = await opened({ forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo" }] } });
    const desk = app.environment("desk");
    const [, forgejo] = desk.forgeAccounts();
    await app.user.click(within(await row("david on git.example.test")).getByRole("button", { name: "Make main" }));
    expect(await within(step()).findByText("david on git.example.test is your main forge. New notebooks go there.")).toBeDefined();
    await waitFor(async () => expect(within(await row("david on git.example.test")).queryByText("Main forge")).not.toBeNull());
    expect(within(await row("david on github.com")).getByRole("button", { name: "Make main" })).toBeDefined();
    expect(desk.requests("forge.accounts.setPrimary").map((request) => request.params)).toMatchObject([{ forgeAccountId: forgejo?.id }]);
    expect(desk.forgeAccounts().map((account) => account.primary)).toEqual([false, true]);
  });
});

describe("Keep this token in your key manager", () => {
  it("shows on a stored token's row alone while a key manager is connected, and opens the Key manager step's Move card", async () => {
    const app = await opened({
      capabilities: ["forge", "keyManagers", "managedTools"],
      forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo", credential: { kind: "gh", login: "david" } }] },
      keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }], items: [{ name: "https://github.com", slug: "github" }] },
    });
    // A token the environment's own gh reads holds nothing to move; a stored one does.
    expect(await within(await row("david on github.com")).findByRole("button", { name: "Keep this token in your key manager" })).toBeDefined();
    expect(within(await row("david on git.example.test")).queryByRole("button", { name: "Keep this token in your key manager" })).toBeNull();
    await app.user.click(within(await row("david on github.com")).getByRole("button", { name: "Keep this token in your key manager" }));
    expect(railStep("Key manager").getAttribute("aria-current")).toBe("step");
    const keyManager = within(checklist()).getByRole("region", { name: "Key manager" });
    await waitFor(() => expect(document.activeElement).toBe(within(keyManager).getByRole("region", { name: "Move stored tokens" })));
    expect(await within(within(keyManager).getByRole("region", { name: "Move stored tokens" })).findByRole("listitem", { name: "https://github.com" })).toBeDefined();
  });

  it("is not offered while no key manager is connected", async () => {
    const app = await opened({ capabilities: ["forge", "keyManagers"], forges: { accounts: [{}] } });
    const github = await row("david on github.com");
    await waitFor(() => expect(app.environment("desk").requests("keyManagers.list").length).toBeGreaterThan(0));
    expect(within(github).queryByRole("button", { name: "Keep this token in your key manager" })).toBeNull();
    expect(within(github).queryByRole("button", { name: "Move to your key manager" })).toBeNull();
  });
});

describe("without admin", () => {
  it("is read-only, saying the capability's line", async () => {
    const app = await opened({}, [
      { name: "laptop", reach: "paired", capabilities: ["forge"], scopes: ["read", "sessions:write", "runs:drive", "terminal"], forges: { accounts: [{}, { origin: "https://git.example.test" }] } },
    ], { on: "laptop" });
    expect(await within(step()).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(step()).getByRole("button", { name: "Add a forge" }).hasAttribute("disabled")).toBe(true);
    expect(within(step()).queryByRole("button", { name: "Use the gh sign-in from this computer" })).toBeNull();
    const forgejo = await row("david on git.example.test");
    expect(within(forgejo).getByRole("button", { name: "Make main" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(forgejo).getByRole("button", { name: "More options" }));
    expect(within(forgejo).getByRole("textbox", { name: "Another address for this site" }).hasAttribute("disabled")).toBe(true);
    expect(within(forgejo).getByRole("button", { name: "Add address" }).hasAttribute("disabled")).toBe(true);
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
            { problem: { kind: "credential-rejected", since: at, message: "github.com did not accept the token for david. Create a new token and add it." }, statusSince: at },
            {
              origin: "https://git.example.test",
              kind: "forgejo",
              credential: { kind: "reference", reference },
              problem: { kind: "credential-unavailable", since: at, message: "agent-harness cannot read the saved token for david on git.example.test. Sign in to your key manager." },
              statusSince: at,
            },
          ],
        },
      },
    ], { on: "laptop" });
    expect(await within(step()).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    const github = await row("david on github.com");
    expect(within(github).getByRole("button", { name: "Add a new token" }).hasAttribute("disabled")).toBe(true);
    const forgejo = await row("david on git.example.test");
    expect(within(forgejo).getByRole("button", { name: "Go to Key manager" }).hasAttribute("disabled")).toBe(false);
    await app.user.click(within(forgejo).getByRole("button", { name: "Go to Key manager" }));
    expect(railStep("Key manager").getAttribute("aria-current")).toBe("step");
  });
});
