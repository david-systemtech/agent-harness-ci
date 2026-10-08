import { screen, waitFor, within } from "@testing-library/react";
import { fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Forges row and pull requests in the window (docs/specs/gui.md,
 * "Settings", "The window and the sidebar" and "A session pane"; forge
 * spec; ADR 0020, ADR 0032; #419): a card per forge account from the cached
 * `forge.accounts.list`, Add by a pasted token with `forge.detect` or by
 * this computer's `gh` through the fake shell, the card's primary,
 * verification, removal and copies, the row opened by a forge notice, and a
 * session's pull requests on its row and its pane's caption, driven through
 * the harness over the scripted environment's forge answers.
 */

/** A token as a person pastes one: nothing a secret scanner takes for a real one. */
const TOKEN = "token-for-tests";

/** The window over `desk`, this machine's environment offering forge, as `desk` scripts it, and the other environments given, paired. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}, others: readonly ScriptedEnvironment[] = [], shell?: FakeShell) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["forge"], ...desk }, ...others] }, shell === undefined ? {} : { shell });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

const settings = () => screen.getByRole("region", { name: "Settings" });

/** The Forges pane. */
const pane = () => within(settings()).getByRole("region", { name: "Forges" });

/** Opens Settings on Forges with Mod+, and the rail, as a person does, on the environment named when it is not the home one. */
const openForges = async (app: RenderedApp, environment?: string) => {
  if (screen.queryByRole("region", { name: "Settings" }) === null) await app.user.keyboard("{Control>},{/Control}");
  const open = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(open).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Forges" }));
  if (environment !== undefined) await app.user.selectOptions(within(pane()).getByRole("combobox", { name: "Environment" }), environment);
  return pane();
};

/** A forge account's card, by its origin. */
const card = (origin: string) => within(pane()).findByRole("region", { name: origin });

/** What a card says of its forge account, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

describe("a forge account's card", () => {
  it("shows verification, primary status and a named dot for every capability", async () => {
    const app = await opened({ forges: { accounts: [{}] } });
    await openForges(app);
    const forge = await card("https://github.com");
    expect(within(forge).getByText("Verified")).toBeDefined();
    expect(within(forge).getByRole("img", { name: "Primary forge" }).querySelector("svg")).not.toBeNull();
    const capabilities = within(forge).getByRole("list", { name: "Capabilities" });
    expect(within(capabilities).getAllByRole("img")).toHaveLength(5);
    expect(within(capabilities).getByRole("img", { name: /Read repositories:.*verified/i })).toBeDefined();
  });

  it("shows what the cached forge.accounts.list holds of it: origin, kind, identity, credential source, status with when it changed, capabilities, primary and a copy's source", async () => {
    const app = await opened({
      forges: {
        accounts: [
          {},
          {
            origin: "https://git.example.test",
            kind: "forgejo",
            credential: { kind: "none" },
            identity: null,
            problem: { kind: "needs-credential", since: "2026-09-01T09:00:00.000Z", message: "No credential for https://git.example.test is on this environment: give it one in Set up, Forges." },
            statusSince: "2026-09-01T09:00:00.000Z",
            copiedFrom: { environmentId: "0199aa00-0000-7000-8000-0000000000aa", environmentName: "laptop" },
          },
        ],
      },
    });
    await openForges(app);
    const github = await card("https://github.com");
    expect(facts(github)).toMatchObject({
      Kind: "GitHub",
      "Signed in as": "david (user 42)",
      Credential: "A pasted token, kept in this environment's vault.",
      Capabilities: "Can read repositories and read releases. Not tried yet: write issues, pull requests and create repositories.",
      Primary: "Yes: repositories go here unless another forge is named.",
    });
    expect(facts(github)["Status"]).toMatch(/^Connected since \d\d:\d\d$/);
    expect(facts(github)).not.toHaveProperty("Copied from");
    expect(within(github).queryByRole("button", { name: "Make primary" })).toBeNull();

    const copied = await card("https://git.example.test");
    expect(facts(copied)).toMatchObject({
      Kind: "Forgejo",
      "Signed in as": "Not known until the forge answers.",
      Credential: "None yet: a copy awaiting a credential on this environment.",
      Status: "Awaiting a credential since 1 Sep 09:00",
      Primary: "No.",
      "Copied from": "laptop",
    });
    expect(within(copied).getByText("No credential for https://git.example.test is on this environment: give it one in Set up, Forges.")).toBeDefined();
    // The vault keeps a token for the stored credential only.
    const [stored, awaiting] = app.environment("desk").forgeAccounts();
    expect(app.environment("desk").forgeToken(stored?.id ?? "")).toBeDefined();
    expect(app.environment("desk").forgeToken(awaiting?.id ?? "")).toBeUndefined();
  });
});

describe("Add by paste", () => {
  it("opens Add inline with provider tiles and keeps the URL when changing providers", async () => {
    const app = await opened();
    const forges = await openForges(app);
    await app.user.click(within(forges).getByRole("button", { name: "Add a forge" }));
    const add = await within(forges).findByRole("region", { name: "Add a forge on desk" });
    expect(screen.queryByRole("dialog", { name: "Add a forge on desk" })).toBeNull();
    expect(document.activeElement).toBe(within(add).getByRole("radio", { name: "GitHub" }));
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://git.example.test");
    await app.user.click(within(add).getByRole("radio", { name: "Forgejo" }));
    expect((within(add).getByRole("textbox", { name: "URL" }) as HTMLInputElement).value).toBe("https://git.example.test");
    expect(within(add).getByRole("button", { name: "Find the forge" }).querySelector("svg")).not.toBeNull();
    await app.user.click(within(add).getByRole("button", { name: "Cancel" }));
    expect(within(forges).queryByRole("region", { name: "Add a forge on desk" })).toBeNull();
    expect(document.activeElement).toBe(within(forges).getByRole("button", { name: "Add a forge" }));
  });

  it("names the URL's kind and token page with forge.detect, sends the token once in forge.accounts.add directly, says a refused one in one line, and keeps it nowhere on the client", async () => {
    const app = await opened({ forges: { rejects: ["token-refused-for-tests"] } });
    const forges = await openForges(app);
    expect(await within(forges).findByText("No forge account is on this environment.")).toBeDefined();
    await app.user.click(within(forges).getByRole("button", { name: "Add a forge" }));
    const add = await screen.findByRole("region", { name: "Add a forge on desk" });

    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "git@github.com:david/agent-harness.git");
    await app.user.click(within(add).getByRole("button", { name: "Find the forge" }));
    const found = await within(add).findByRole("region", { name: "The forge found" });
    expect(within(found).getByText("GitHub at https://github.com.")).toBeDefined();
    const page = within(found).getByRole("button", { name: /^https:\/\/github\.com\/settings\/personal-access-tokens\/new/ });
    expect(within(found).getByText(/^A fine-grained token with access to all repositories and Contents \(write\)/)).toBeDefined();
    // The token page opens in the OS's browser.
    await app.user.click(page);
    expect(app.shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", page.textContent]]);

    await app.user.type(within(add).getByLabelText("Token"), "token-refused-for-tests");
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("Not added: https://github.com refused the token (HTTP 401): nothing was stored.")).toBeDefined();
    expect((within(add).getByLabelText("Token") as HTMLInputElement).value).toBe("");
    const desk = app.environment("desk");
    expect(desk.forgeAccounts()).toEqual([]);

    await app.user.type(within(add).getByLabelText("Token"), TOKEN);
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    expect(await within(forges).findByText("Added david on github.com.")).toBeDefined();
    expect(facts(await card("https://github.com"))["Credential"]).toBe("A pasted token, kept in this environment's vault.");

    const adds = desk.requests("forge.accounts.add");
    expect(adds.map((request) => request.params)).toMatchObject([
      { url: "git@github.com:david/agent-harness.git", kind: "github", credential: { kind: "stored", provenance: "pasted", token: "token-refused-for-tests" } },
      { url: "git@github.com:david/agent-harness.git", kind: "github", credential: { kind: "stored", provenance: "pasted", token: TOKEN } },
    ]);
    const [account] = desk.forgeAccounts();
    expect(desk.forgeToken(account?.id ?? "")).toBe(TOKEN);
    // Sent directly, never through the outbox, and kept nowhere the client stores.
    const kept = JSON.stringify([app.platform.documents.entries(), app.shell.calls]);
    expect(kept).not.toContain(TOKEN);
    expect(kept).not.toContain("token-refused-for-tests");
  });

  it("says in one line a URL that is no forge", async () => {
    const app = await opened({ forges: { detect: { "https://intranet.example.test": "not_a_forge" } } });
    await app.user.click(within(await openForges(app)).getByRole("button", { name: "Add a forge" }));
    const add = await screen.findByRole("region", { name: "Add a forge on desk" });
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://intranet.example.test/wiki");
    await app.user.click(within(add).getByRole("button", { name: "Find the forge" }));
    expect(await within(add).findByText("The forge could not be told: https://intranet.example.test answered, but not as a forge the harness knows: name its kind to add it anyway.")).toBeDefined();
    expect(within(add).queryByRole("region", { name: "The forge found" })).toBeNull();
  });

  it("drops what forge.detect found once the URL was edited while it answered, and the add carries no kind for the URL typed", async () => {
    const app = await opened();
    await app.user.click(within(await openForges(app)).getByRole("button", { name: "Add a forge" }));
    const add = await screen.findByRole("region", { name: "Add a forge on desk" });
    const desk = app.environment("desk");
    const url = within(add).getByRole("textbox", { name: "URL" });
    await app.user.type(url, "https://github.com");
    const release = desk.holdDetects();
    await app.user.click(within(add).getByRole("button", { name: "Find the forge" }));
    await waitFor(() => expect(desk.requests("forge.detect")).toHaveLength(1));
    await app.user.clear(url);
    await app.user.type(url, "https://git.example.test");
    release();
    await waitFor(() => expect(within(add).getByRole("button", { name: "Find the forge" }).hasAttribute("disabled")).toBe(false));
    expect(within(add).queryByRole("region", { name: "The forge found" })).toBeNull();

    await app.user.type(within(add).getByLabelText("Token"), TOKEN);
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    const [added] = desk.requests("forge.accounts.add");
    expect(added?.params).toMatchObject({ url: "https://git.example.test" });
    expect(added?.params).not.toHaveProperty("kind");
  });
});

describe("Add from this computer's gh", () => {
  it("hands the gh token for the URL's host over once through the fake shell, as client-gh, and the card says it will not follow gh's rotations", async () => {
    const shell = fakeShell();
    shell.answer("gh.token", async (host) => (host === "github.com" ? "gh-token-for-tests" : undefined));
    const app = await opened({}, [], shell);
    await app.user.click(within(await openForges(app)).getByRole("button", { name: "Add a forge" }));
    const add = await screen.findByRole("region", { name: "Add a forge on desk" });
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://git.example.test");
    await app.user.click(within(add).getByRole("button", { name: "Use the gh signed in on this computer" }));
    expect(
      await within(add).findByText("Not added: The gh on this computer is not signed in to git.example.test: run gh auth login --hostname git.example.test here, or paste a token."),
    ).toBeDefined();
    const desk = app.environment("desk");
    expect(desk.requests("forge.accounts.add")).toEqual([]);

    await app.user.clear(within(add).getByRole("textbox", { name: "URL" }));
    await app.user.type(within(add).getByRole("textbox", { name: "URL" }), "https://github.com");
    await app.user.click(within(add).getByRole("button", { name: "Use the gh signed in on this computer" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a forge on desk" })).toBeNull());
    expect(facts(await card("https://github.com"))["Credential"]).toBe("The gh token milo@desk handed over once: it will not follow gh's rotations.");

    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([
      ["gh.token", "git.example.test"],
      ["gh.token", "github.com"],
    ]);
    const adds = desk.requests("forge.accounts.add");
    expect(adds).toHaveLength(1);
    expect(adds[0]?.params).toMatchObject({ url: "https://github.com", credential: { kind: "stored", provenance: "client-gh", token: "gh-token-for-tests" } });
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain("gh-token-for-tests");
  });

  it("is absent with its reason where the shell has no gh", async () => {
    const app = await opened({}, [], { ...fakeShell(), gh: undefined } as unknown as FakeShell);
    await app.user.click(within(await openForges(app)).getByRole("button", { name: "Add a forge" }));
    const add = await screen.findByRole("region", { name: "Add a forge on desk" });
    expect(within(add).queryByRole("button", { name: "Use the gh signed in on this computer" })).toBeNull();
    expect(within(add).getByText("This app cannot use the gh tool signed in on this computer here. Add a token instead.")).toBeDefined();
  });
});

describe("the card's verbs", () => {
  it("makes another forge account primary, verifies now, and removes one only once it is confirmed", async () => {
    const app = await opened({ forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo" }] } });
    const forges = await openForges(app);
    const desk = app.environment("desk");

    await app.user.click(within(await card("https://git.example.test")).getByRole("button", { name: "Make primary" }));
    expect(await within(forges).findByText("david on git.example.test is the primary forge: new repositories go there unless another is named.")).toBeDefined();
    await waitFor(() => expect(facts(within(pane()).getByRole("region", { name: "https://git.example.test" }))["Primary"]).toMatch(/^Yes/));
    expect(facts(await card("https://github.com"))["Primary"]).toBe("No.");
    expect(desk.forgeAccounts().map((account) => account.primary)).toEqual([false, true]);

    const [github] = desk.forgeAccounts();
    await app.user.click(within(await card("https://github.com")).getByRole("button", { name: "Verify now" }));
    expect(await within(forges).findByText("Verified david on github.com.")).toBeDefined();
    expect(desk.requests("forge.accounts.verify").map((request) => request.params)).toEqual([{ forgeAccountId: github?.id }]);

    await app.user.click(within(await card("https://github.com")).getByRole("button", { name: "Remove" }));
    const confirm = await dialog("Remove https://github.com?");
    await app.user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("forge.accounts.remove")).toEqual([]);
    await app.user.click(within(await card("https://github.com")).getByRole("button", { name: "Remove" }));
    await app.user.click(within(await dialog("Remove https://github.com?")).getByRole("button", { name: "Remove" }));
    expect(await within(forges).findByText("Removed david on github.com.")).toBeDefined();
    await waitFor(() => expect(within(pane()).queryByRole("region", { name: "https://github.com" })).toBeNull());
    expect(desk.forgeAccounts().map((account) => account.origin)).toEqual(["https://git.example.test"]);
  });

  it("copies to the environments this client holds an admin connection to, one line each", async () => {
    const app = await opened({ forges: { accounts: [{}] } }, [
      { name: "laptop", reach: "paired", capabilities: ["forge"] },
      { name: "tablet", reach: "paired", capabilities: ["forge"], forges: { accounts: [{}] } },
      { name: "phone", reach: "paired", capabilities: ["forge"], scopes: ["read", "sessions:write", "runs:drive", "terminal"] },
    ]);
    await openForges(app);
    await app.user.click(within(await card("https://github.com")).getByRole("button", { name: "Copy to other environments" }));
    const copy = await dialog("Copy https://github.com to other environments");
    expect(within(copy).getAllByRole("checkbox").map((box) => box.getAttribute("name"))).toEqual(["laptop", "tablet"]);
    await app.user.click(within(copy).getByRole("checkbox", { name: "laptop" }));
    await app.user.click(within(copy).getByRole("checkbox", { name: "tablet" }));
    await app.user.click(within(copy).getByRole("button", { name: "Copy" }));
    expect(await within(copy).findByText("laptop: copied: No credential for https://github.com is on this environment: give it one in Set up, Forges.")).toBeDefined();
    expect(within(copy).getByText("tablet: not copied: A forge account for https://github.com is on this environment already.")).toBeDefined();
    const [copied] = app.environment("laptop").forgeAccounts();
    expect(copied).toMatchObject({ origin: "https://github.com", credential: { kind: "none" }, copiedFrom: { environmentName: "desk" } });
    expect(app.environment("phone").requests("forge.accounts.add")).toEqual([]);
  });
});

describe("the row's reach", () => {
  it("opens from a forge notice's action, on that notice's environment", async () => {
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: ["forge"], forges: { accounts: [{}] } }]);
    const laptop = app.environment("laptop");
    const [account] = laptop.forgeAccounts();
    await waitFor(() => expect(laptop.requests("environment.subscribe").length).toBeGreaterThan(0));
    laptop.verifyForge(account?.id ?? "", { kind: "credential-rejected", message: "github.com refused the token (HTTP 401): give it a new one in Set up, Forges." });
    const notices = await screen.findByRole("region", { name: /^Notifications/ });
    const toast = await within(notices).findByRole("listitem");
    expect(toast.textContent).toContain("https://github.com on laptop: github.com refused the token (HTTP 401): give it a new one in Set up, Forges.");
    await app.user.click(within(toast).getByRole("button", { name: "Open Forges" }));
    expect(within(within(pane()).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent).toBe("laptop");
    expect(facts(await card("https://github.com"))["Status"]).toMatch(/^Credential rejected since /);
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("is absent with its reason without the forge flag, and read-only with the capability's line without admin", async () => {
    const app = await opened({ capabilities: [] }, [
      { name: "laptop", reach: "paired", capabilities: ["forge"], scopes: ["read", "sessions:write", "runs:drive", "terminal"], forges: { accounts: [{}, { origin: "https://git.example.test" }] } },
    ]);
    const desk = await openForges(app);
    expect(within(desk).getByText("desk runs an older agent-harness without this. Update expect(within(desk).getByText("desk to use it.")).toBeDefined();
    expect(within(desk).queryByRole("button", { name: "Add a forge" })).toBeNull();

    const laptop = await openForges(app, "laptop");
    expect(await within(laptop).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(laptop).getByRole("button", { name: "Add a forge" }).hasAttribute("disabled")).toBe(true);
    for (const name of ["Verify now", "Remove"]) expect(within(await card("https://github.com")).getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    expect(within(await card("https://git.example.test")).getByRole("button", { name: "Make primary" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("pull requests where sessions are drawn", () => {
  it("shows a session's pull-request state on its row, kept current, and the pane's caption links each, opened through openExternal", async () => {
    const url = "https://github.com/david/agent-harness/pull/12";
    const app = await opened({ sessions: [{ title: "Forges in the window", pullRequests: [{ url, state: "open", mergedAt: null, closedAt: null }] }, { title: "No pull request" }] });
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    const row = within(sidebar).getByRole("button", { name: /Forges in the window/ });
    expect(within(row).getByRole("img", { name: "Pull request #12, open" }).textContent).toBe("PR open");
    expect(within(within(sidebar).getByRole("button", { name: /No pull request/ })).queryByRole("img", { name: /^Pull request/ })).toBeNull();

    const desk = app.environment("desk");
    const sessionId = desk.sessionId(0);
    const merged = { url, state: "merged" as const, mergedAt: app.clock.now().toISOString(), closedAt: app.clock.now().toISOString() };
    desk.emit(sessionId, "session.pull-request-synced", { url, state: "merged", mergedAt: merged.mergedAt, closedAt: merged.closedAt }, { fields: { pullRequests: [merged] } });
    expect(await within(row).findByRole("img", { name: "Pull request #12, merged" })).toBeDefined();

    await app.user.click(row);
    await app.user.keyboard("{Control>}\\{/Control}");
    const link = await screen.findByRole("button", { name: "Pull request #12, merged" });
    expect(link.textContent).toBe("PR #12 merged");
    await app.user.click(link);
    expect(app.shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", url]]);
  });
});
