import { uuidv4 } from "@agent-harness/client-runtime";
import { registry, type BankJoinPreview, type BankRecord, type ParamsOf } from "@agent-harness/contracts";
import { screen, waitFor, within } from "@testing-library/react";
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
    expect(within(await within(card).findByRole("region", { name: "current" })).queryByRole("button", { name: "Update validator" })).toBeNull();
    await app.user.click(within(olderCard).getByRole("button", { name: "Update validator" }));
    const review = await within(olderCard).findByRole("button", { name: "Awaiting owner review" });
    expect(review.getAttribute("title")).toBe("https://github.com/david/older/pull/1");
    expect(desk.requests("banks.validator.update").at(-1)?.params).toMatchObject({ bankId: older.id, commandId: expect.any(String) });
  });

  it.each(["failed", "landed"] as const)("shows the validator update's returned %s state", async (state) => {
    const older = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "older", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), validator: { installedVersion: 1, currentVersion: 2, needsUpdate: true } };
    const { app, desk, card } = await open({}, [older]);
    const landing = state === "failed" ? { state, bank: "older", step: "pull-request", reason: "The forge is unavailable.\nTry again." } : { state, bank: "older", pullRequest: null, files: [{ path: ".agent-harness/validate.mjs", state: "present" }] };
    desk.wire.answer("banks.validator.update", () => accepted({ version: 2, landing }));
    const row = await within(card).findByRole("region", { name: "older" });
    await app.user.click(within(row).getByRole("button", { name: "Update validator" }));
    if (state === "failed") expect((await within(row).findByRole("alert")).textContent).toBe("Validator update failed at pull-request: The forge is unavailable. Try again.");
    else expect(await within(row).findByText("Validator update verified on main.")).toBeDefined();
  });

  it("disables an outdated bank's validator action without admin", async () => {
    const older = { ...bank({ commandId: "0199aa00-0000-7000-8000-000000000001", bankId: "0199aa00-0000-4000-8000-000000000002", name: "older", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } }), validator: { installedVersion: 1, currentVersion: 2, needsUpdate: true } };
    const { card } = await open({ scopes: ["read"] }, [older]);
    expect((await within(card).findByRole("button", { name: "Update validator" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(await within(notes).findByText("Default for Personal mail, Team")).toBeDefined();
    await app.user.click(within(notes).getByText("Repository and scope"));
    expect(within(notes).getByText("Personal mail, Team")).toBeDefined();
    expect(notes.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("shows the cached bank controls read-only without admin", async () => {
    const { card } = await open({ scopes: ["read"] });
    const create = await within(card).findByRole("button", { name: "Create" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Keep it on this machine for now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByText(/Read-only:/)).toBeDefined();
  });

  it("keeps command and preview refusals on one line", async () => {
    const { app, desk, card } = await open();
    desk.wire.answer("banks.create", () => ({ result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "That name is taken.\nChoose another.", data: { reason: "name_taken" } } } } }));
    await within(card).findByRole("textbox", { name: "Bank name" });
    await app.user.click(within(card).getByRole("button", { name: "Create" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("That name is taken. Choose another.");
    desk.wire.answer("banks.join.preview", () => ({ error: { code: "internal", message: "Cannot read this bank.\nTry later.", data: {} } }));
    await app.user.click(within(card).getByRole("radio", { name: "Join a bank" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Bank link" }), "https://github.com/platform/memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    expect(await within(card).findByText("Cannot read this bank. Try later.")).toBeDefined();
  });

  it("lists only verified forges and replaces live owners when a different forge is picked", async () => {
    const { app, desk, card } = await open({ forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo", primary: false }, { origin: "https://offline.example.test", identity: null, problem: { kind: "needs-credential", since, message: "No credential." } }] } });
    const nextId = desk.forgeAccounts()[1]?.id ?? "";
    desk.wire.answer("forge.orgs.list", (params) => ({ result: { owners: params.forgeAccountId === nextId ? [{ login: "other-team", kind: "organisation" as const }] : [{ login: "david", kind: "user" as const }, { login: "first-team", kind: "organisation" as const }] } }));
    await app.user.click(within(card).getByRole("radio", { name: "Team" }));
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

  it("previews a join and attaches exactly the account ticked, with none preset", async () => {
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
    await app.user.click(within(card).getByRole("radio", { name: "Join a bank" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Bank link" }), "https://github.com/platform/team-memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    const facts = await within(card).findByRole("region", { name: "Bank preview" });
    for (const text of ["Platform team's shared memory.", "Platform organisation", "Runtime project", "how-we-work", "Shared with the team: no personal facts, no secrets.", "Can read: yes. Can push: no."]) expect(within(facts).getByText(text)).toBeDefined();
    for (const name of ["Organisations", "Projects", "Entities", "Orientation", "Access and review"]) expect(within(facts).getByRole("heading", { name })).toBeDefined();
    expect(facts.textContent).toContain("engine");
    expect(facts.textContent).toContain("david, alex");
    expect(facts.textContent).toContain("orientation, decisions, status, manifest");
    for (const chip of within(card).getAllByRole("checkbox")) expect((chip as HTMLInputElement).checked).toBe(false);
    await app.user.click(within(card).getByRole("checkbox", { name: "Work" }));
    await app.user.clear(within(card).getByRole("textbox", { name: "Bank link" }));
    expect(within(card).queryByRole("region", { name: "Bank preview" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Join" })).toBeNull();
    await app.user.type(within(card).getByRole("textbox", { name: "Bank link" }), "https://github.com/platform/team-memory");
    await app.user.click(within(card).getByRole("button", { name: "Preview" }));
    await within(card).findByRole("region", { name: "Bank preview" });
    expect((within(card).getByRole("checkbox", { name: "Work" }) as HTMLInputElement).checked).toBe(false);
    await app.user.click(within(card).getByRole("checkbox", { name: "Work" }));
    await app.user.click(within(card).getByRole("button", { name: "Join" }));
    await waitFor(() => expect(desk.requests("banks.join")).toHaveLength(1));
    expect(desk.requests("banks.join").at(-1)?.params).toMatchObject({ url: "https://github.com/platform/team-memory", accounts: ["work"], repositories: "all" });
  });

  it("creates a team under a live organisation owner and offers its invitation and copyable join link", async () => {
    const { app, desk, card } = await open();
    desk.wire.answer("forge.orgs.list", () => ({ result: { owners: [{ login: "david", kind: "user" as const }, { login: "team-org", kind: "organisation" as const }] } }));
    await app.user.click(within(card).getByRole("radio", { name: "Team" }));
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
    await app.user.click(within(card).getByRole("button", { name: "Create" }));
    const invite = await within(card).findByRole("button", { name: "Invite teammates on github.com" });
    expect(invite.getAttribute("title")).toBe("https://github.com/orgs/team-org/people");
    await app.user.click(invite);
    expect(app.shell.calls).toContainEqual(["openExternal", "https://github.com/orgs/team-org/people"]);
    const link = within(card).getByRole("region", { name: "Join link" });
    await app.user.click(within(link).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "https://github.com/team-org/platform-team"]);
    expect(desk.requests("banks.create").at(-1)?.params).toMatchObject({ name: "platform-team", creation: { kind: "team", owner: { login: "team-org", kind: "organisation" }, repositoryName: "platform-team", teamName: "Platform Team", org: "platform-team", projects: [{ name: "Runtime", folder: "runtime" }, { name: "Desktop", folder: "desktop" }] } });
  });

  it("keeps a real local bank and offers Publish, including after the card is reopened", async () => {
    const { app, desk, card } = await open();
    await within(card).findByRole("textbox", { name: "Bank name" });
    await app.user.click(within(card).getByRole("button", { name: "Keep it on this machine for now" }));
    expect(await within(card).findByText("This bank lives on this machine only until you publish it.")).toBeDefined();
    expect(desk.requests("banks.create").at(-1)?.params["creation"]).toMatchObject({ kind: "personal", localOnly: true });
    await app.user.click(within(card).getByRole("button", { name: "Skip for now" }));
    await app.user.click(screen.getByRole("button", { name: "Memory bank" }));
    desk.wire.answer("banks.publish", (raw) => {
      const params = registry["banks.publish"].params.parse(raw);
      const published = bank({ commandId: params.commandId, bankId: params.bankId, name: "david-memory", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } });
      scriptBanks(desk, [published]);
      return accepted({ bank: published, review: { state: "awaiting-review" as const, bank: published.name, pullRequest: "https://github.com/david/david-memory/pull/1", files: [] }, followUps: [] });
    });
    await app.user.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.queryByText("This bank lives on this machine only until you publish it.")).toBeNull());
    expect(desk.requests("banks.publish").at(-1)?.params["bankId"]).toBe(desk.requests("banks.create").at(-1)?.params["bankId"]);
  });

  it("proposes personal seed answers, creates an edited name and embeds its describe conversation", async () => {
    const { app, desk, card } = await open();
    expect((await within(card).findByRole("textbox", { name: "Bank name" }) as HTMLInputElement).value).toBe("david-memory");
    expect((within(card).getByRole("textbox", { name: "What do you call your own work?" }) as HTMLInputElement).value).toBe("personal");
    expect((within(card).getByRole("textbox", { name: "Your first project" }) as HTMLInputElement).value).toBe("harness");
    await app.user.clear(within(card).getByRole("textbox", { name: "Bank name" }));
    await app.user.type(within(card).getByRole("textbox", { name: "Bank name" }), "my-memory");
    await app.user.click(within(card).getByRole("button", { name: "Create" }));
    await within(card).findByRole("button", { name: "Describe this bank" });
    expect(desk.requests("banks.create").at(-1)?.params).toMatchObject({ name: "my-memory", creation: { kind: "personal", localOnly: false, org: "personal", project: "harness" } });
    desk.wire.answer("setup.mint", async () => {
      const id = uuidv4();
      await app.runtime.commands.dispatch(desk.environmentId, "sessions.create", { id, title: "Describe memory", workspace: { kind: "scratch" } });
      desk.startRun(id, "Describe this bank.");
      return accepted({ sessionId: id });
    });
    await app.user.click(within(card).getByRole("button", { name: "Describe this bank" }));
    expect(await within(await screen.findByRole("dialog", { name: "Authoring conversation" })).findByRole("textbox", { name: "Message" })).toBeDefined();
    expect(desk.requests("setup.mint").at(-1)?.params).toMatchObject({ step: "memory-bank", subject: desk.requests("banks.create").at(-1)?.params["bankId"], variant: "first" });
  });
});
