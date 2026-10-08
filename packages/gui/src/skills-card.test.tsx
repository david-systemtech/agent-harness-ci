import { screen, waitFor, within } from "@testing-library/react";
import { CATALOGUE, type SkillsProbeResult, type SkillsView, type SkillsViewMember, type SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Skills step's card (setup-copy.md §5.9; #1855): catalogue cards with
 * one button, Add from a link in More options, the probe's refusals said
 * plainly with git's words in Details, and the member, always-on and trust
 * controls left to Settings › Skills.
 */

const source: SkillsViewSource = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e", url: "https://github.com/theclaymethod/unslop", identity: "https://github.com/theclaymethod/unslop", folder: ".",
  follow: { kind: "branch", branch: "main" }, position: 1, addedBy: { kind: "client_session", id: "desk" }, addedAt: "2026-09-29T10:00:00.000Z",
  commit: "c".repeat(40), skillCount: 1, sync: { outcome: "ok", since: "2026-09-29T10:00:00.000Z" }, attemptedAt: "2026-09-29T10:00:00.000Z",
};
const linked = "https://git.example.test/team/procedures";
const found: SkillsProbeResult = {
  probeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", identity: linked, branch: "main", commit: "d".repeat(40), root: null, truncated: false,
  folders: [{ folder: "skills", count: 2, licence: null, members: [
    { name: "review", path: "review", description: "Review a change.", invocation: "model+slash", problems: [] },
    { name: "tdd", path: "tdd", description: "Test first.", invocation: "model+slash", problems: [] },
  ] }],
};
const initial = (): SkillsView => ({ ownDirectory: "/home/test/skills/own", sources: [], choices: [], accountId: "writer",
  accounts: [{ accountId: "writer", channel: "system-prompt-append", reason: null }], members: [] });
const accepted = (result: Record<string, unknown>) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result } });
const unreachable = (problem: string, message: string, line: string) => ({ error: { code: "conflict", message, data: { reason: "unreachable", problem, line, origin: "https://git.example.test" } } });
const card = () => screen.getByRole("region", { name: "Skills" });
const steps = () => screen.getByRole("navigation", { name: "Set up steps" });
const opened = async (value = initial(), given: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ id: "writer", label: "Writer" }], ...given }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const desk = app.environment("desk");
  let skills = value;
  desk.wire.answer("skills.get", () => ({ result: skills }));
  desk.wire.answer("trust.list", () => ({ result: { trusted: [], declined: [] } }));
  await app.user.click(within(steps()).getByRole("button", { name: "Skills" }));
  await within(card()).findByRole("region", { name: "Unslop" });
  return { app, desk, update: (next: SkillsView) => { skills = next; desk.notice("skills.updated", {}); } };
};
/** Opens More options, which stays open for the window's life once opened, and looks for skills at `address`. */
const lookFor = async (app: Awaited<ReturnType<typeof opened>>["app"], address: string) => {
  const more = within(card()).getByRole("button", { name: "More options" });
  if (more.getAttribute("aria-expanded") !== "true") await app.user.click(more);
  await app.user.type(within(card()).getByRole("textbox", { name: "Repository address" }), address);
  await app.user.click(within(card()).getByRole("button", { name: "Look for skills" }));
};

describe("the Skills card's catalogue", () => {
  it("offers each collection with its count and Add, its licence, size and skills under Details, and nothing added", async () => {
    const { app, desk } = await opened();
    const unslop = within(card()).getByRole("region", { name: "Unslop" });
    expect(within(unslop).getByText("1 skill")).toBeDefined();
    expect(within(unslop).getByRole("button", { name: "Add" })).toBeDefined();
    expect(within(unslop).queryByText(/MIT/)).toBeNull();
    expect(within(card()).queryByRole("checkbox")).toBeNull();
    await app.user.click(within(unslop).getByRole("button", { name: "Details" }));
    expect(within(unslop).getByText(/^Licence: MIT/)).toBeDefined();
    expect(within(unslop).getByText(/about 1481 tokens on every run/)).toBeDefined();
    expect(within(unslop).getByText(/^unslop: /)).toBeDefined();
    const engineering = within(card()).getByRole("region", { name: "Matt Pocock — engineering" });
    await app.user.click(within(engineering).getByRole("button", { name: "Details" }));
    expect(within(engineering).getByText("Changes often.")).toBeDefined();
    for (const entry of CATALOGUE.skills) expect(within(card()).getByText(entry.pitch)).toBeDefined();
    expect(within(card()).queryByText("You can follow up to 20 collections.")).toBeNull();
    // Add from a link waits in the More options fold, shut until chosen.
    expect(within(card()).getByRole("button", { name: "More options" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(card()).queryByRole("textbox", { name: "Repository address" })).toBeNull();
    expect(desk.requests("skills.sources.add")).toHaveLength(0);
  });

  it("adds a collection with one button, then reads Added with Remove, which removes it with one more", async () => {
    const { app, desk, update } = await opened();
    desk.wire.answer("skills.sources.add", (params) => {
      expect(params).toMatchObject({ url: source.url, folder: ".", follow: { kind: "branch", branch: null } });
      update({ ...initial(), sources: [source] });
      return accepted({ source });
    });
    desk.wire.answer("skills.sources.remove", (params) => {
      expect(params.sourceId).toBe(source.id);
      update(initial());
      return accepted({ source });
    });
    const unslop = within(card()).getByRole("region", { name: "Unslop" });
    await app.user.click(within(unslop).getByRole("button", { name: "Add" }));
    expect(await within(unslop).findByText("Added")).toBeDefined();
    await app.user.click(within(unslop).getByRole("button", { name: "Remove" }));
    expect(await within(unslop).findByRole("button", { name: "Add" })).toBeDefined();
    expect(desk.requests("skills.sources.remove")).toHaveLength(1);
    expect(within(unslop).queryByRole("dialog")).toBeNull();
  });

  it("says the 20-collection limit once, above the list, from 15 collections on", async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...source, id: `0f8fad5b-d9cb-469f-a165-${String(index).padStart(12, "0")}`, identity: linked, url: linked, folder: `skills-${index}`, position: index + 1 }));
    const { update } = await opened({ ...initial(), sources: many(14) });
    expect(within(card()).queryByText("You can follow up to 20 collections.")).toBeNull();
    update({ ...initial(), sources: many(15) });
    expect(await within(card()).findAllByText("You can follow up to 20 collections.")).toHaveLength(1);
  });

  it("says a refused add plainly in the collection's card, as an alert", async () => {
    const { app, desk } = await opened();
    desk.wire.answer("skills.sources.add", () => ({ error: { code: "conflict", message: "You can follow up to 20 collections. Remove one first.", data: { reason: "source_limit", limit: 20 } } }));
    const unslop = within(card()).getByRole("region", { name: "Unslop" });
    await app.user.click(within(unslop).getByRole("button", { name: "Add" }));
    const alert = await within(unslop).findByRole("alert");
    expect(within(alert).getByText("You can follow up to 20 collections. Remove one first.")).toBeDefined();
    expect(alert.textContent).toMatch(/^Error: You can follow up to 20 collections\./);
    expect(within(unslop).getByRole("button", { name: "Add" })).toBeDefined();
  });

  it("keeps Add greyed with its reason in words on a connection that cannot change settings", async () => {
    await opened({ ...initial(), sources: [source] }, { scopes: ["read"] });
    const unslop = within(card()).getByRole("region", { name: "Unslop" });
    await waitFor(() => expect(within(unslop).getByText("Added")).toBeDefined());
    expect((within(unslop).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(unslop).getAllByText(/change settings or sign in accounts/).length).toBeGreaterThan(0);
  });
});

describe("the Skills card's lines and actions", () => {
  it("updates the collections the result names without leaving Set up", async () => {
    const { app, desk, update } = await opened({ ...initial(), sources: [source] }, { setup: { skills: {
      state: "needs-attention", reason: "Unslop could not update. Choose Update now.", failing: ["skills.sources-synced"], actions: ["pull-now"],
      targets: [{ action: "pull-now", kind: "skill-source", id: source.id, label: "Unslop" }],
    } } });
    desk.wire.answer("skills.sources.pull", (params) => {
      expect(params.sourceId).toBe(source.id);
      update({ ...initial(), sources: [{ ...source, commit: "d".repeat(40) }] });
      return accepted({ source, layoutMoved: false });
    });
    await app.user.click(await within(card()).findByRole("button", { name: "Update now: Unslop" }));
    expect(await within(card()).findByText("Unslop is up to date.")).toBeDefined();
    expect(steps()).toBeDefined();
  });

  it("asks to choose a moved collection's folders, looks for them again and puts the chosen ones in its place", async () => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["agents"] } };
    const { app, desk, update } = await opened({ ...initial(), sources: [moved] }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", (params) => {
      expect(params).toEqual({ url: linked });
      return { result: { ...found, folders: [{ ...found.folders[0]!, folder: "agents" }] } };
    });
    const replacement = { ...moved, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", folder: "agents", skillCount: 2, sync: { outcome: "ok", since: source.addedAt } } as const;
    desk.wire.answer("skills.sources.add", (params) => {
      expect(params).toMatchObject({ url: linked, folder: "agents", probeId: found.probeId, follow: { kind: "branch", branch: null } });
      update({ ...initial(), sources: [moved, replacement] });
      return accepted({ source: replacement });
    });
    desk.wire.answer("skills.sources.remove", (params) => {
      expect(params.sourceId).toBe(moved.id);
      update({ ...initial(), sources: [replacement] });
      return accepted({ source: moved });
    });
    expect(within(card()).queryByRole("button", { name: /^Update now/ })).toBeNull();
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    expect(await within(card()).findByText("Found 1 skill folder:")).toBeDefined();
    await app.user.click(within(card()).getByRole("checkbox", { name: "agents · 2 skills" }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    await waitFor(() => expect(desk.requests("skills.sources.remove")).toHaveLength(1));
    expect(desk.requests("skills.sources.add")).toHaveLength(1);
  });

  it("leaves member cards, always-on switches and repository trust to Settings, and All skill settings opens Settings › Skills", async () => {
    const member: SkillsViewMember = {
      name: "unslop", kind: "skill", path: "unslop", description: "Remove machine-written prose.", invocation: "model+slash", userInvocable: true,
      argumentHint: null, whileActive: [], origin: { kind: "repository", repository: source.identity, path: "." }, layer: { kind: "source", sourceId: source.id },
      size: 5924, tokens: 1481, problems: [], warnings: [], shadowedBy: null, native: false, enabled: true, alwaysOn: false, choices: [],
    };
    const { app, desk } = await opened({ ...initial(), sources: [source], members: [member] });
    expect(within(card()).queryByRole("switch")).toBeNull();
    expect(within(card()).queryByText(/Trust also admits/)).toBeNull();
    expect(within(card()).queryByText(source.commit)).toBeNull();
    expect(desk.requests("trust.list")).toHaveLength(0);
    expect(within(card()).getByText("Leaves Set up")).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "All skill settings" }));
    expect(within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: "Skills" })).toBeDefined();
  });
});

describe("the Skills card's Add from a link", () => {
  it("sits in More options: Look for skills lists the folders found, and Add selected adds the ones ticked", async () => {
    const { app, desk, update } = await opened();
    desk.wire.answer("skills.probe", (params) => {
      expect(params).toEqual({ url: linked });
      return { result: found };
    });
    const added = { ...source, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", url: linked, identity: linked, folder: "skills", skillCount: 2 };
    desk.wire.answer("skills.sources.add", (params) => {
      expect(params).toMatchObject({ url: linked, folder: "skills", probeId: found.probeId, follow: { kind: "branch", branch: null } });
      update({ ...initial(), sources: [added] });
      return accepted({ source: added });
    });
    await lookFor(app, linked);
    expect(await within(card()).findByText("Found 1 skill folder:")).toBeDefined();
    expect((within(card()).getByRole("button", { name: "Add selected" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card()).getByText("Choose a skill folder first.")).toBeDefined();
    await app.user.click(within(card()).getByRole("checkbox", { name: "skills · 2 skills" }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    expect(await within(card()).findByText("Added team/procedures (skills).")).toBeDefined();
  });

  it("answers an address that is not a repository's with an instruction, sending nothing and keeping what was typed", async () => {
    const { app, desk } = await opened();
    await lookFor(app, "my skills");
    const alert = await within(card()).findByRole("alert");
    expect(alert.textContent).toBe("Error: Enter the address of a repository, like https://github.com/you/skills.");
    expect(alert.textContent).not.toContain("params");
    expect(desk.requests("skills.probe")).toHaveLength(0);
    expect((within(card()).getByRole("textbox", { name: "Repository address" }) as HTMLInputElement).value).toBe("my skills");
  });

  it("names a missing git on the computer, git's words only under Details", async () => {
    const { app, desk } = await opened();
    desk.wire.answer("skills.probe", () => unreachable("git_missing", "Git is not installed on desk. Install Git, then try again.", "spawn git ENOENT"));
    await lookFor(app, linked);
    const alert = await within(card()).findByRole("alert");
    expect(within(alert).getByText("Git is not installed on desk. Install Git, then try again.")).toBeDefined();
    expect(within(card()).queryByText(/ENOENT/)).toBeNull();
    await app.user.click(within(alert).getByRole("button", { name: "Details" }));
    expect(within(alert).getByText(/spawn git ENOENT/)).toBeDefined();
  });

  it("tells a private repository from a missing or slow one, and a private one's Go to Forges opens the Forges step", async () => {
    const { app, desk } = await opened();
    let answer = unreachable("not_found", "agent-harness found no repository at this address.", "fatal: repository not found");
    desk.wire.answer("skills.probe", () => answer);
    await lookFor(app, linked);
    expect(within(await within(card()).findByRole("alert")).getByText("agent-harness found no repository at this address.")).toBeDefined();
    expect(within(card()).queryByRole("button", { name: "Go to Forges" })).toBeNull();

    answer = unreachable("network", "git.example.test did not answer in time. Try again.", "git was stopped after 60 seconds.");
    await app.user.click(within(card()).getByRole("button", { name: "Look for skills" }));
    expect(await within(card()).findByText("git.example.test did not answer in time. Try again.")).toBeDefined();

    answer = unreachable("authentication", "This repository is private. Add a forge for git.example.test first.", "fatal: Authentication failed");
    await app.user.click(within(card()).getByRole("button", { name: "Look for skills" }));
    expect(await within(card()).findByText("This repository is private. Add a forge for git.example.test first.")).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Go to Forges" }));
    expect(await screen.findByRole("region", { name: "Forges" })).toBeDefined();
  });

  it("says No skill folders were found there for a repository with none", async () => {
    const { app, desk } = await opened();
    desk.wire.answer("skills.probe", () => ({ result: { ...found, folders: [] } }));
    await lookFor(app, linked);
    expect(await within(card()).findByText("No skill folders were found there.")).toBeDefined();
    expect(within(card()).queryByRole("button", { name: "Add selected" })).toBeNull();
  });
});
