import { uuidv4 } from "@agent-harness/client-runtime";
import { registry, type BankJoinPreview, type BankRecord, type ParamsOf } from "@agent-harness/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment, type EnvironmentHandle } from "../test/harness.js";

const since = "2026-10-02T00:00:00.000Z";
const bank = (params: ParamsOf<"banks.create">): BankRecord => ({
  id: params.bankId, name: params.name, kind: params.creation.kind,
  location: params.creation.kind === "personal" && params.creation.localOnly ? { kind: "local" } : { kind: "remote", origin: "https://github.com", repository: `${params.creation.kind === "team" ? params.creation.owner.login : "david"}/${params.name}` },
  checkout: `/banks/${params.name}`, role: "read-write", enabled: true, accounts: "all", repositories: "all", defaultFor: [], pins: [], mergeOverride: "none", privateCopy: false, credential: "forge", importedFrom: null, copiedFrom: null, createdAt: since,
  status: { reachable: { state: "reachable", since }, manifest: { state: "valid", since }, orientation: { missing: [], since }, owners: { unresolved: [], since }, lastSync: null, landing: { state: "ok", since } },
  memories: 0, folders: 0, line: "Your memory.", sharedAliases: [],
});
const accepted = <T,>(result: T) => ({ result: { receipt: { status: "accepted" as const, sequence: 1, changed: true }, result } });
const scriptBanks = (desk: EnvironmentHandle, initial: BankRecord[] = []) => {
  let banks = initial;
  desk.wire.answer("banks.list", () => ({ result: { banks } }));
  desk.wire.answer("banks.create", (raw) => {
    const params = registry["banks.create"].params.parse(raw);
    const created = bank(params);
    banks = [...banks, created];
    return accepted({ bank: created });
  });
};
const open = async (more: Partial<ScriptedEnvironment> = {}, initial: BankRecord[] = []) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"], accounts: [{ id: "work", label: "Work" }, { id: "home", label: "Home" }], forges: { accounts: [{}] }, sessions: [{ title: "Work", repositoryIdentity: "https://github.com/david/harness" }], ...more }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const desk = app.environment("desk");
  scriptBanks(desk, initial);
  await app.user.click(await screen.findByRole("button", { name: "Memory bank" }));
  const card = await screen.findByRole("region", { name: "Memory bank" });
  return { app, desk, card };
};

describe("the Memory bank card", () => {
  it("offers an outdated bank's validator update and shows the returned review state", async () => {
    const older = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "older", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), validator: { installedVersion: 1, currentVersion: 2, needsUpdate: true } };
    const current = { ...older, id: "0199aa00-0000-4000-8000-000000000003", name: "current", validator: { installedVersion: 2, currentVersion: 2, needsUpdate: false } };
    const { app, desk, card } = await open({}, [older, current]);
    desk.wire.answer("banks.validator.update", () => accepted({ version: 2, landing: { state: "awaiting-review", bank: "older", pullRequest: "https://github.com/david/older/pull/1", files: [{ path: ".agent-harness/validate.mjs", state: "pending" }] } }));
    const olderCard = await within(card).findByRole("region", { name: "older" });
    expect(within(await within(card).findByRole("region", { name: "current" })).queryByRole("button", { name: "Update the rules" })).toBeNull();
    expect(within(olderCard).getByText("older uses an older copy of the notebook rules.")).toBeDefined();
    await app.user.click(within(olderCard).getByRole("button", { name: "Update the rules" }));
    expect(await within(olderCard).findByText("older's latest changes are waiting for your approval on github.com.")).toBeDefined();
    const review = within(olderCard).getByRole("button", { name: "Open the review" });
    expect(review.getAttribute("title")).toBe("https://github.com/david/older/pull/1");
    expect(desk.requests("banks.validator.update").at(-1)?.params).toMatchObject({ bankId: older.id, commandId: expect.any(String) });
  });

  it.each(["failed", "landed"] as const)("shows the validator update's returned %s state", async (state) => {
    const older = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "older", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), validator: { installedVersion: 1, currentVersion: 2, needsUpdate: true } };
    const { app, desk, card } = await open({}, [older]);
    const landing = state === "failed" ? { state, bank: "older", step: "pull-request", reason: "The forge is unavailable.\nTry again." } : { state, bank: "older", pullRequest: null, files: [{ path: ".agent-harness/validate.mjs", state: "present" }] };
    desk.wire.answer("banks.validator.update", () => accepted({ version: 2, landing }));
    const row = await within(card).findByRole("region", { name: "older" });
    await app.user.click(within(row).getByRole("button", { name: "Update the rules" }));
    if (state === "failed") {
      expect((await within(row).findByRole("alert")).textContent).toBe("Error: The last change to older could not be saved to github.com.");
      expect(within(within(row).getByRole("region", { name: "Details" })).getByText("pull-request: The forge is unavailable.\nTry again.", { normalizer: (text) => text })).toBeDefined();
    } else expect(await within(row).findByText("The rules are up to date.")).toBeDefined();
  });

  it("disables an outdated bank's validator action without admin", async () => {
    const older = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "older", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), validator: { installedVersion: 1, currentVersion: 2, needsUpdate: true } };
    const { card } = await open({ scopes: ["read"] }, [older]);
    expect((await within(card).findByRole("button", { name: "Update the rules" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps each bank's authoring actions on its own card", async () => {
    const first = bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "first", creation: { kind: "personal", localOnly: true, org: "personal", project: "harness" } });
    const second = { ...first, id: "0199aa00-0000-4000-8000-000000000003", name: "second" };
    const { card } = await open({ setup: { "memory-bank": { state: "done", actions: ["revise"], targets: [{ action: "revise", kind: "bank", id: first.id, label: "First" }, { action: "revise", kind: "bank", id: second.id, label: "Second" }] } } }, [first, second]);
    const firstCard = await within(card).findByRole("region", { name: "first" });
    expect(within(firstCard).getByRole("button", { name: "Fix the description: First" })).toBeDefined();
    expect(within(firstCard).queryByRole("button", { name: "Fix the description: Second" })).toBeNull();
  });

  it("names the accounts a bank is the default for and is scoped to by their labels, never their ids (ticket 1752)", async () => {
    const personal = "0bcb960d-1b0b-48d8-81f6-49fe44341431";
    const team = "da2d4db4-7bec-465c-b7ec-91938a15e3d2";
    const scoped = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "notes", creation: { kind: "personal", localOnly: true, org: "personal", project: "harness" } }), accounts: [personal, team], defaultFor: [personal, team] };
    const { app, card } = await open({ accounts: [{ id: personal, label: "Personal mail" }, { id: team, label: "Team" }] }, [scoped]);
    const notes = await within(card).findByRole("region", { name: "notes" });
    const details = (await within(notes).findAllByRole("button", { name: "Details" })).find((button) => button.closest("[data-step-status]") === null);
    expect(details).toBeDefined();
    await app.user.click(details!);
    expect(within(notes).getAllByText("Personal mail, Team")).toHaveLength(2);
    expect(notes.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("shows the cached bank controls read-only without admin", async () => {
    const { card } = await open({ scopes: ["read"] });
    const create = await within(card).findByRole("button", { name: "Create notebook" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Keep it on this computer for now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByText(/^You can look but not change this\. /)).toBeDefined();
  });

  // setup-copy.md §5.8 and §3: a refusal is the environment's plain line, or plainRefusal's, never cut at 120 characters; its raw words are in Details.
  it("says a refusal's whole line, never cut, with its raw words in Details", async () => {
    const { app, desk, card } = await open();
    const long = "These answers do not make a notebook agent-harness can use. Check the names and try again, then choose Create notebook once more.";
    desk.wire.answer("banks.create", () => ({ result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "invalid_params", error: { code: "invalid_params", message: long, data: { issues: [], details: ["projects/personal: not a folder name"] } } } } }));
    await within(card).findByRole("textbox", { name: "Name" });
    await app.user.click(within(card).getByRole("button", { name: "Create notebook" }));
    const refusal = await within(card).findByRole("alert");
    expect(refusal.textContent).toBe(`Error: ${long}`);
    expect(card.querySelector("[data-bank-form]")!.compareDocumentPosition(refusal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByRole("region", { name: "Details" }).textContent).toContain("projects/personal: not a folder name");
    desk.wire.answer("banks.join.preview", () => ({ error: { code: "internal", message: "TypeError: cannot read properties of undefined (reading 'clone')", data: {} } }));
    await app.user.click(within(card).getByRole("radio", { name: "Join my team's notebook" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Notebook link" }), "https://github.com/platform/memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("Error: agent-harness ran into a problem. Choose Preview to try again.");
    expect(within(card).getByRole("region", { name: "Details" }).textContent).toContain("TypeError: cannot read properties of undefined (reading 'clone')");
  });

  it("words a refused switch through plainRefusal, not the environment's raw message", async () => {
    const notes = bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "notes", creation: { kind: "personal", localOnly: true, org: "personal", project: "harness" } });
    const { app, desk, card } = await open({}, [notes]);
    desk.wire.answer("banks.registry.update", () => ({ error: { code: "not_found", message: `No bank ${notes.id} is registered on this environment.`, data: {} } }));
    await app.user.click(within(await within(card).findByRole("region", { name: "notes" })).getByRole("button", { name: "Turn off" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("Error: agent-harness could not find what this needs. Choose Turn off to try again.");
    expect(within(card).getByRole("region", { name: "Details" }).textContent).toContain(`No bank ${notes.id} is registered on this environment.`);
  });

  it("lists only verified forges and replaces live owners when a different forge is picked", async () => {
    const { app, desk, card } = await open({ forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo", primary: false }, { origin: "https://offline.example.test", identity: null, problem: { kind: "needs-credential", since, message: "No credential." } }] } });
    const nextId = desk.forgeAccounts()[1]?.id ?? "";
    desk.wire.answer("forge.orgs.list", (params) => ({ result: { owners: params.forgeAccountId === nextId ? [{ login: "other-team", kind: "organisation" as const }] : [{ login: "david", kind: "user" as const }, { login: "first-team", kind: "organisation" as const }] } }));
    await app.user.click(within(card).getByRole("radio", { name: "Create a notebook for my team" }));
    await within(card).findByRole("option", { name: "first-team" });
    await app.user.selectOptions(within(card).getByRole("combobox", { name: "Owner" }), "first-team");
    const forge = within(card).getByRole("combobox", { name: "Forge" });
    expect(within(forge).queryByRole("option", { name: /offline/ })).toBeNull();
    await app.user.selectOptions(forge, nextId);
    await within(card).findByRole("option", { name: "other-team" });
    expect((within(card).getByRole("combobox", { name: "Owner" }) as HTMLSelectElement).value).toBe("other-team");
    expect(within(card).queryByRole("option", { name: "first-team" })).toBeNull();
    expect(desk.requests("forge.orgs.list").at(-1)?.params["forgeAccountId"]).toBe(nextId);
  });

  it("previews a join in §5.8's words and attaches every account but the one unticked", async () => {
    const { app, desk, card } = await open();
    const preview: BankJoinPreview = {
      name: "team-memory", kind: "team", line: "Platform team's shared memory.",
      orgs: [{ path: "platform", line: "Platform organisation" }], projects: [{ path: "platform/runtime", line: "Runtime project" }],
      entities: [{ name: "Runtime", aliases: ["engine"], folder: "platform/runtime/" }], orientation: ["how-we-work"], owners: ["david", "alex"],
      merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] }, rules: ["No personal facts.", "No secrets."], canRead: true, canPush: false,
    };
    desk.wire.answer("banks.join.preview", () => ({ result: preview }));
    desk.wire.answer("banks.join", (raw) => {
      const params = registry["banks.join"].params.parse(raw);
      const joined = { ...bank({ commandId: params.commandId, bankId: params.bankId, name: "team-memory", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), kind: "team" as const, role: "read-only" as const, accounts: params.accounts };
      scriptBanks(desk, [joined]);
      return accepted({ bank: joined });
    });
    await app.user.click(within(card).getByRole("radio", { name: "Join my team's notebook" }));
    expect(within(card).queryByText(/^Forge: /)).toBeNull();
    await app.user.type(within(card).getByRole("textbox", { name: "Notebook link" }), "https://github.com/platform/team-memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    const facts = await within(card).findByRole("region", { name: "Notebook preview" });
    expect(within(facts).getByRole("heading", { name: "team-memory: Platform team's shared memory." })).toBeDefined();
    for (const name of ["Owners", "Projects"]) expect(within(facts).getByRole("heading", { name })).toBeDefined();
    for (const text of ["david, alex", "Runtime project", "Shared with the team: no personal facts, no secrets."]) expect(within(facts).getByText(text)).toBeDefined();
    for (const jargon of ["Entities", "Orientation", "Can push"]) expect(within(facts).queryByText(new RegExp(jargon))).toBeNull();
    await app.user.click(within(facts).getByRole("button", { name: "Details" }));
    expect(facts.textContent).toContain("Can read: yes. Can push: no.");
    const accounts = within(card).getByRole("group", { name: "Which of your accounts should use it?" });
    for (const chip of within(accounts).getAllByRole("checkbox")) expect((chip as HTMLInputElement).checked).toBe(true);
    await app.user.click(within(card).getByRole("checkbox", { name: "Home" }));
    await app.user.clear(within(card).getByRole("textbox", { name: "Notebook link" }));
    expect(within(card).queryByRole("region", { name: "Notebook preview" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Join notebook" })).toBeNull();
    await app.user.type(within(card).getByRole("textbox", { name: "Notebook link" }), "https://github.com/platform/team-memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    await within(card).findByRole("region", { name: "Notebook preview" });
    expect((within(card).getByRole("checkbox", { name: "Home" }) as HTMLInputElement).checked).toBe(true);
    await app.user.click(within(card).getByRole("checkbox", { name: "Home" }));
    await app.user.click(within(card).getByRole("button", { name: "Join notebook" }));
    await waitFor(() => expect(desk.requests("banks.join")).toHaveLength(1));
    expect(desk.requests("banks.join").at(-1)?.params).toMatchObject({ url: "https://github.com/platform/team-memory", accounts: ["work"], repositories: "all" });
  });

  it("creates a team under a live organisation owner and offers its invitation and copyable join link", async () => {
    const { app, desk, card } = await open();
    desk.wire.answer("forge.orgs.list", () => ({ result: { owners: [{ login: "david", kind: "user" as const }, { login: "team-org", kind: "organisation" as const }] } }));
    await app.user.click(within(card).getByRole("radio", { name: "Create a notebook for my team" }));
    const forge = await within(card).findByRole("combobox", { name: "Forge" });
    expect((forge as HTMLSelectElement).value).toBe(desk.forgeAccounts()[0]?.id);
    await within(card).findByRole("option", { name: "team-org" });
    expect(desk.requests("forge.orgs.list").at(-1)?.params["forgeAccountId"]).toBe(desk.forgeAccounts()[0]?.id);
    await app.user.selectOptions(within(card).getByRole("combobox", { name: "Owner" }), "team-org");
    await app.user.type(within(card).getByRole("textbox", { name: "Team name" }), "Platform Team");
    expect((within(card).getByRole("textbox", { name: "Repository name" }) as HTMLInputElement).value).toBe("platform-team");
    expect((within(card).getByRole("textbox", { name: "First organisation" }) as HTMLInputElement).value).toBe("platform-team");
    await app.user.type(within(card).getByRole("textbox", { name: "First projects (one per line)" }), "Runtime\nDesktop");
    expect(within(card).getByText("Every teammate needs an account on github.com.")).toBeDefined();
    await app.user.click(within(card).getByRole("button", { name: "Create notebook" }));
    const invite = await within(card).findByRole("button", { name: "Invite teammates on github.com" });
    expect(invite.getAttribute("title")).toBe("https://github.com/orgs/team-org/people");
    await app.user.click(invite);
    expect(app.shell.calls).toContainEqual(["openExternal", "https://github.com/orgs/team-org/people"]);
    const link = within(card).getByRole("region", { name: "Notebook link" });
    await app.user.click(within(link).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "https://github.com/team-org/platform-team"]);
    expect(desk.requests("banks.create").at(-1)?.params).toMatchObject({ name: "platform-team", creation: { kind: "team", owner: { login: "team-org", kind: "organisation" }, repositoryName: "platform-team", teamName: "Platform Team", org: "platform-team", projects: [{ name: "Runtime", folder: "runtime" }, { name: "Desktop", folder: "desktop" }] } });
  });

  it("keeps a real local bank and offers to move it to the forge, including after the card is reopened", async () => {
    const { app, desk, card } = await open();
    await within(card).findByRole("textbox", { name: "Name" });
    await app.user.click(within(card).getByRole("button", { name: "Keep it on this computer for now" }));
    expect(await within(card).findByText("david-memory is on this computer only. Move it to your forge to use it on other computers too.")).toBeDefined();
    expect(within(within(card).getByRole("region", { name: "david-memory" })).getByText("On this computer only")).toBeDefined();
    expect(desk.requests("banks.create").at(-1)?.params["creation"]).toMatchObject({ kind: "personal", localOnly: true });
    await app.user.click(within(card).getByRole("button", { name: "Skip for now" }));
    await app.user.click(screen.getByRole("button", { name: "Memory bank" }));
    desk.wire.answer("banks.publish", (raw) => {
      const params = registry["banks.publish"].params.parse(raw);
      const published = bank({ commandId: params.commandId, bankId: params.bankId, name: "david-memory", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } });
      scriptBanks(desk, [published]);
      return accepted({ bank: published, review: { state: "awaiting-review" as const, bank: published.name, pullRequest: "https://github.com/david/david-memory/pull/1", files: [] }, followUps: [] });
    });
    await app.user.click(await screen.findByRole("button", { name: "Move to your forge" }));
    await waitFor(() => expect(screen.queryByText(/is on this computer only/)).toBeNull());
    expect(desk.requests("banks.publish").at(-1)?.params["bankId"]).toBe(desk.requests("banks.create").at(-1)?.params["bankId"]);
  });

  it("proposes personal seed answers, creates an edited name and embeds its describe conversation", async () => {
    const { app, desk, card } = await open();
    expect((await within(card).findByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("david-memory");
    expect((within(card).getByRole("textbox", { name: "What do you call your own work?" }) as HTMLInputElement).value).toBe("personal");
    expect((within(card).getByRole("textbox", { name: "Your first project" }) as HTMLInputElement).value).toBe("harness");
    await app.user.clear(within(card).getByRole("textbox", { name: "Name" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Name" }), "my-memory");
    await app.user.click(within(card).getByRole("button", { name: "Create notebook" }));
    await within(card).findByRole("button", { name: "Describe it" });
    expect(desk.requests("banks.create").at(-1)?.params).toMatchObject({ name: "my-memory", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } });
    desk.wire.answer("setup.mint", async () => {
      const id = uuidv4();
      await app.runtime.commands.dispatch(desk.environmentId, "sessions.create", { id, title: "Describe memory", workspace: { kind: "scratch" } });
      desk.startRun(id, "Describe this bank.");
      return accepted({ sessionId: id });
    });
    await app.user.click(within(card).getByRole("button", { name: "Describe it" }));
    expect(await within(await screen.findByRole("dialog", { name: "Authoring conversation" })).findByRole("textbox", { name: "Message" })).toBeDefined();
    expect(desk.requests("setup.mint").at(-1)?.params).toMatchObject({ step: "memory-bank", subject: desk.requests("banks.create").at(-1)?.params["bankId"], variant: "first" });
  });
  // setup-copy.md §5.8: the question and its three choices, and the ready-to-go row as visible text (#1853).
  it("asks what you would like and shows the forge a new notebook goes to", async () => {
    const { app, card } = await open();
    const choices = await within(card).findByRole("radiogroup", { name: "What would you like?" });
    expect(within(choices).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["Create my own notebook", "Join my team's notebook", "Create a notebook for my team"]);
    expect(within(choices).getByRole("radio", { name: "Create my own notebook" }).getAttribute("aria-checked")).toBe("true");
    expect((await within(card).findByText("Forge: david on github.com")).textContent).toBe("Forge: david on github.comReady");
    await app.user.click(within(choices).getByRole("radio", { name: "Create a notebook for my team" }));
    expect(within(card).queryByText(/^Forge: /)).toBeNull();
    expect((await within(card).findByRole("combobox", { name: "Forge" }) as HTMLSelectElement).value).toBe(app.environment("desk").forgeAccounts()[0]?.id);
  });

  it("says No forge yet with Go to Forges, which opens the Forges step inside Set up, and still keeps a notebook on this computer", async () => {
    const { app, desk, card } = await open({ forges: { accounts: [] } });
    expect(await within(card).findByText("No forge yet.")).toBeDefined();
    const create = within(card).getByRole("button", { name: "Create notebook" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(create.hasAttribute("aria-describedby")).toBe(false);
    await app.user.click(within(card).getByRole("button", { name: "Keep it on this computer for now" }));
    await waitFor(() => expect(desk.requests("banks.create").at(-1)?.params["creation"]).toMatchObject({ kind: "personal", localOnly: true }));
    await app.user.click(within(card.querySelector<HTMLElement>("[data-bank-ready]")!).getByRole("button", { name: "Go to Forges" }));
    expect(await screen.findByRole("region", { name: "Forges" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Memory bank" })).toBeNull();
  });

  it("keeps Create enabled and says Enter {field} beside each field a press found empty, sending nothing", async () => {
    const { app, desk, card } = await open();
    const name = await within(card).findByRole("textbox", { name: "Name" });
    expect(within(card).getByText("Used as a folder name, for example personal.")).toBeDefined();
    expect(within(card).getByText("For example the name of a repository you work on.")).toBeDefined();
    await app.user.clear(name);
    await app.user.clear(within(card).getByRole("textbox", { name: "Your first project" }));
    await app.user.click(within(card).getByRole("button", { name: "Create notebook" }));
    const errors = within(card).getAllByRole("alert");
    expect(errors.map((error) => error.textContent)).toEqual(["Error: Enter a name.", "Error: Enter your first project."]);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain(errors[0]!.id);
    expect(desk.requests("banks.create")).toHaveLength(0);
    await app.user.type(name, "notes");
    await app.user.type(within(card).getByRole("textbox", { name: "Your first project" }), "harness");
    await app.user.click(within(card).getByRole("button", { name: "Create notebook" }));
    await waitFor(() => expect(desk.requests("banks.create")).toHaveLength(1));
    expect(within(card).queryByText("Enter a name.")).toBeNull();
  });

  it("keeps Preview enabled and says Enter a notebook link beside an empty link, reading nothing", async () => {
    const { app, desk, card } = await open();
    await app.user.click(await within(card).findByRole("radio", { name: "Join my team's notebook" }));
    const preview = within(card).getByRole("button", { name: "Preview" }) as HTMLButtonElement;
    expect(preview.disabled).toBe(false);
    await app.user.click(preview);
    expect((await within(card).findByRole("alert")).textContent).toBe("Error: Enter a notebook link.");
    const link = within(card).getByRole("textbox", { name: "Notebook link" });
    expect(link.getAttribute("aria-invalid")).toBe("true");
    expect(desk.requests("banks.join.preview")).toHaveLength(0);
  });

  it("puts Choose a forge on the Forge field when there is none, not on Owner", async () => {
    const { app, desk, card } = await open({ forges: { accounts: [] } });
    await app.user.click(await within(card).findByRole("radio", { name: "Create a notebook for my team" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Team name" }), "Platform");
    await app.user.type(within(card).getByRole("textbox", { name: "First projects (one per line)" }), "harness");
    await app.user.click(within(card).getByRole("button", { name: "Create notebook" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("Error: Choose a forge.");
    expect(within(card).getByRole("combobox", { name: "Forge" }).getAttribute("aria-invalid")).toBe("true");
    expect(within(card).getByRole("combobox", { name: "Owner" }).hasAttribute("aria-invalid")).toBe(false);
    expect(desk.requests("banks.create")).toHaveLength(0);
  });

  it("says the main forge's account needs a fix first, with Go to Forges, not No forge yet", async () => {
    const { card } = await open({ forges: { accounts: [{ problem: { kind: "credential-rejected", since, message: "Sign in again." } }] } });
    const row = await waitFor(() => card.querySelector<HTMLElement>("[data-bank-ready]")!);
    expect(within(row).getByText("Your account on github.com needs a fix first.")).toBeDefined();
    expect(within(row).getByRole("button", { name: "Go to Forges" })).toBeDefined();
    expect(within(card).queryByText("No forge yet.")).toBeNull();
  });

  it("shows a notebook's badges and its description's state in words, the rest in Details", async () => {
    const team = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "team-memory", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), kind: "team" as const, enabled: false };
    const broken = { ...team, id: "0199aa00-0000-4000-8000-000000000003", name: "broken", status: { ...team.status, manifest: { state: "invalid" as const, rule: "retired_key", message: "BANK.md uses description.", since } } };
    const { app, card } = await open({}, [team, broken]);
    const row = await within(card).findByRole("region", { name: "team-memory" });
    expect([...row.querySelectorAll("[data-bank-badge]")].map((badge) => badge.textContent)).toEqual(["Team", "Off", "On github.com", "Description: ready"]);
    expect(row.textContent).not.toMatch(/Manifest|Validator|Remote|Read and write/);
    const problem = within(card).getByRole("region", { name: "broken" });
    expect(within(problem).getByText("Description: has a problem")).toBeDefined();
    expect(within(problem).queryByText(/BANK\.md/)).toBeNull();
    await app.user.click(within(problem).getByRole("button", { name: "Details" }));
    expect(within(problem).getByText("retired_key: BANK.md uses description.")).toBeDefined();
  });

  it("says what Describe it does after Create, names the conversation's states, and opens the review", async () => {
    const fresh = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "notes", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }) };
    const missing = { ...fresh, status: { ...fresh.status, manifest: { state: "missing" as const, since } } };
    const { app, desk, card } = await open({}, [missing]);
    const row = await within(card).findByRole("region", { name: "notes" });
    expect(within(row).getByText("Now describe your notebook. An agent asks a few questions and writes the description.")).toBeDefined();
    const id = uuidv4();
    desk.wire.answer("setup.mint", async () => {
      await app.runtime.commands.dispatch(desk.environmentId, "sessions.create", { id, title: "Describe notes", workspace: { kind: "scratch" } });
      desk.startRun(id, "Describe this bank.");
      return accepted({ sessionId: id });
    });
    await app.user.click(within(row).getByRole("button", { name: "Describe it" }));
    const dialog = await screen.findByRole("dialog", { name: "Authoring conversation" });
    expect(within(dialog).getByRole("status", { name: "Authoring status" }).textContent).toBe("Writing the description…");
    act(() => desk.openPrompt(id, { kind: "question", input: null, questions: [{ header: "Kept", question: "What should it keep?", options: [], multiSelect: false }] }));
    await waitFor(() => expect(within(dialog).getByRole("status", { name: "Authoring status" }).textContent).toBe("Waiting for your answer"));
    const pullRequest = "https://github.com/david/notes/pull/2";
    scriptBanks(desk, [{ ...fresh, status: { ...fresh.status, manifest: { state: "awaiting-review", pullRequest, since } } }]);
    act(() => { app.runtime.requests.refresh(desk.environmentId, "banks.list", {}); });
    await waitFor(() => expect(within(row).getByText("Saved. Waiting for your approval on github.com.")).toBeDefined());
    await app.user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    await app.user.click(within(row).getByRole("button", { name: "Open the review" }));
    expect(app.shell.calls).toContainEqual(["openExternal", pullRequest]);
  });

  it.each([
    ["forge_account_missing", "agent-harness cannot see a notebook at this link. If it is private, add a forge for github.com first."],
    ["credential_unavailable", "Your account on github.com needs a fix first."],
  ])("says a preview the forge refused with %s in the environment's §5.8 line, the forge's words in Details", async (code, line) => {
    const { app, desk, card } = await open();
    desk.wire.answer("banks.join.preview", () => ({ error: { code, message: line, data: { origin: "https://github.com", step: "forges", details: ["The forge asked for a credential."] } } }));
    await app.user.click(await within(card).findByRole("radio", { name: "Join my team's notebook" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Notebook link" }), "https://github.com/platform/team-memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    expect((await within(card).findByRole("alert")).textContent).toBe(`Error: ${line}`);
    expect(within(card).getByRole("region", { name: "Details" }).textContent).toContain("The forge asked for a credential.");
  });

  it("holds Move to your forge with the main forge's needs-a-fix line, not Choose your main forge, when its account has a problem", async () => {
    const notes = bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "notes", creation: { kind: "personal", localOnly: true, org: "personal", project: "harness" } });
    const { card } = await open({ forges: { accounts: [{ problem: { kind: "credential-rejected", since, message: "Sign in again." } }] } }, [notes]);
    const row = await within(card).findByRole("region", { name: "notes" });
    expect(await within(row).findByText("Your account on github.com needs a fix first.")).toBeDefined();
    expect(within(row).queryByText("Choose your main forge before you move this notebook to it.")).toBeNull();
    expect((within(row).getByRole("button", { name: "Move to your forge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByRole("button", { name: "Go to Forges" })).toBeDefined();
  });

  it("joins in §5.8's words: a link the forge account cannot read, and the environment's refusal of a bad link", async () => {
    const { app, desk, card } = await open();
    const preview: BankJoinPreview = {
      name: "team-memory", kind: "team", line: "Shared memory.", orgs: [], projects: [], entities: [{ name: "Runtime", aliases: ["engine"] }], orientation: ["how-we-work"], owners: ["alex"],
      merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] }, rules: ["No personal facts.", "No secrets."], canRead: false, canPush: false,
    };
    desk.wire.answer("banks.join.preview", (params) => params["url"] === "https://github.com/platform/team-memory"
      ? { result: preview }
      : { error: { code: "invalid_params", message: "That is not a notebook link. Paste the link an owner shared with you.", data: { issues: [], details: ["https://github.com/platform names no repository."] } } });
    await app.user.click(within(card).getByRole("radio", { name: "Join my team's notebook" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Notebook link" }), "https://github.com/platform/team-memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("Error: Your forge account cannot read this notebook. Ask an owner to add you.");
    expect(within(card).queryByRole("button", { name: "Join notebook" })).toBeNull();
    await app.user.clear(within(card).getByRole("textbox", { name: "Notebook link" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Notebook link" }), "https://github.com/platform");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("Error: That is not a notebook link. Paste the link an owner shared with you.");
    expect(within(card).getByRole("region", { name: "Details" }).textContent).toContain("https://github.com/platform names no repository.");
  });
});
