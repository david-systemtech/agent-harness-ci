import { act, screen, waitFor, within } from "@testing-library/react";
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

  it("keeps a pinned collection out of the branch folder chooser even when an older computer offers it", async () => {
    const pinned: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", follow: { kind: "pinned", commit: source.commit }, skillCount: 0 };
    const { app, desk } = await opened({ ...initial(), sources: [pinned] }, { setup: { skills: {
      state: "needs-attention", reason: "Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: pinned.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", () => ({ result: found }));
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    expect(await within(card()).findByText("team/procedures (skills) is pinned. Open All skill settings to change its folders or version.")).toBeDefined();
    expect(within(card()).queryByRole("region", { name: "Choose folders for team/procedures (skills)" })).toBeNull();
    expect(desk.requests("skills.probe")).toHaveLength(0);
    expect(desk.requests("skills.sources.add")).toHaveLength(0);
    expect(desk.requests("skills.sources.remove")).toHaveLength(0);
  });

  it("asks to choose a moved collection's folders, looks for them again on its branch and puts the chosen ones in its place", async () => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["agents"] } };
    const { app, desk, update } = await opened({ ...initial(), sources: [moved] }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", (params) => {
      expect(params).toEqual({ url: linked, branch: "main" });
      return { result: { ...found, folders: [{ ...found.folders[0]!, folder: "agents" }] } };
    });
    const replacement = { ...moved, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", folder: "agents", skillCount: 2, sync: { outcome: "ok", since: source.addedAt } } as const;
    desk.wire.answer("skills.sources.add", (params) => {
      expect(params).toMatchObject({ url: linked, folder: "agents", probeId: found.probeId, follow: { kind: "branch", branch: "main" } });
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
    expect(desk.requests("skills.probe")).toHaveLength(1);
  });

  it("replaces a restored original folder without trying to add it beside its tracked duplicate", async () => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["skills"] } };
    let followed: SkillsViewSource[] = [moved];
    const { app, desk, update } = await opened({ ...initial(), sources: followed }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", () => ({ result: found }));
    const replacement = { ...moved, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", skillCount: 2, sync: { outcome: "ok", since: source.addedAt } } as const;
    const calls: string[] = [];
    desk.wire.answer("skills.sources.add", () => {
      calls.push("add");
      if (followed.some((held) => held.identity === linked && held.folder === "skills")) return { error: { code: "conflict", message: "You already follow this collection.", data: { reason: "duplicate", sourceId: moved.id } } };
      followed = [...followed, replacement];
      update({ ...initial(), sources: followed });
      return accepted({ source: replacement });
    });
    desk.wire.answer("skills.sources.remove", () => {
      calls.push("remove");
      followed = followed.filter((held) => held.id !== moved.id);
      update({ ...initial(), sources: followed });
      return accepted({ source: moved });
    });
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    await app.user.click(await within(card()).findByRole("checkbox", { name: "skills · 2 skills" }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    expect(await within(card()).findByText("Added team/procedures (skills).")).toBeDefined();
    expect(calls).toEqual(["remove", "add"]);
    expect(followed.map((held) => held.id)).toEqual([replacement.id]);
  });

  it("retries a refused removal after adding replacement folders, without adding those folders again", async () => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["agents"] } };
    const { app, desk, update } = await opened({ ...initial(), sources: [moved] }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", () => ({ result: { ...found, folders: [{ ...found.folders[0]!, folder: "agents" }] } }));
    const replacement = { ...moved, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", folder: "agents", skillCount: 2, sync: { outcome: "ok", since: source.addedAt } } as const;
    desk.wire.answer("skills.sources.add", () => {
      update({ ...initial(), sources: [moved, replacement] });
      return accepted({ source: replacement });
    });
    let removes = 0;
    desk.wire.answer("skills.sources.remove", () => {
      if (removes++ === 0) return { error: { code: "internal", message: "Removal did not finish. Try again.", data: {} } };
      update({ ...initial(), sources: [replacement] });
      return accepted({ source: moved });
    });
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    await app.user.click(await within(card()).findByRole("checkbox", { name: "agents · 2 skills" }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    const panel = within(card()).getByRole("region", { name: "Choose folders for team/procedures (skills)" });
    expect(await within(panel).findByRole("alert")).toBeDefined();
    const retry = within(card()).getByRole("button", { name: "Add selected" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    await app.user.click(retry);
    await waitFor(() => expect(desk.requests("skills.sources.remove")).toHaveLength(2));
    await waitFor(() => expect(within(card()).queryByRole("region", { name: "Choose folders for team/procedures (skills)" })).toBeNull());
    expect(desk.requests("skills.sources.add")).toHaveLength(1);
    expect(within(card()).getByText("Added team/procedures (agents).")).toBeDefined();
  });

  it("at the limit of 20 collections, removes the moved collection first so its chosen folders fit", async () => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["agents"] } };
    const others = Array.from({ length: 19 }, (_, index): SkillsViewSource => ({
      ...source, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, url: `https://git.example.test/team/c${index}`, identity: `https://git.example.test/team/c${index}`, position: index + 2,
    }));
    let followed: SkillsViewSource[] = [moved, ...others];
    const { app, desk, update } = await opened({ ...initial(), sources: followed }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", () => ({ result: { ...found, folders: [{ ...found.folders[0]!, folder: "agents" }] } }));
    const replacement = { ...moved, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", folder: "agents", skillCount: 2, sync: { outcome: "ok", since: source.addedAt } } as const;
    desk.wire.answer("skills.sources.add", () => {
      if (followed.length >= 20) return { error: { code: "conflict", message: "You can follow up to 20 collections. Remove one first.", data: { reason: "source_limit", limit: 20 } } };
      followed = [...followed, replacement];
      update({ ...initial(), sources: followed });
      return accepted({ source: replacement });
    });
    desk.wire.answer("skills.sources.remove", (params) => {
      followed = followed.filter((held) => held.id !== params.sourceId);
      update({ ...initial(), sources: followed });
      return accepted({ source: moved });
    });
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    await app.user.click(await within(card()).findByRole("checkbox", { name: "agents · 2 skills" }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    await waitFor(() => expect(desk.requests("skills.sources.add")).toHaveLength(1));
    expect(desk.requests("skills.sources.remove").map((request) => request.params)).toEqual([expect.objectContaining({ sourceId: moved.id })]);
    expect(followed.map((held) => held.id)).toContain(replacement.id);
    expect(followed.map((held) => held.id)).not.toContain(moved.id);
    expect(within(card()).queryByText("You can follow up to 20 collections. Remove one first.")).toBeNull();
  });

  /** At 20 collections, one of them moved: Choose folders removes it to make room for `folders`, and the add numbered `refused` is refused. */
  const refusedAtLimit = async ({ folders = ["agents"], refused = 0 }: { readonly folders?: readonly string[]; readonly refused?: number } = {}) => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["agents"] } };
    const others = Array.from({ length: 19 }, (_, index): SkillsViewSource => ({
      ...source, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, url: `https://git.example.test/team/c${index}`, identity: `https://git.example.test/team/c${index}`, position: index + 2,
    }));
    let followed: SkillsViewSource[] = [moved, ...others];
    const { app, desk, update } = await opened({ ...initial(), sources: followed }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", () => ({ result: { ...found, folders: folders.map((folder) => ({ ...found.folders[0]!, folder })) } }));
    const replacement = { ...moved, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", folder: "agents", skillCount: 2, sync: { outcome: "ok", since: source.addedAt } } as const;
    let adds = 0;
    desk.wire.answer("skills.sources.add", () => {
      if (adds++ === refused) return unreachable("unreachable", "agent-harness could not reach git.example.test.", "fatal: unable to access");
      followed = [...followed, replacement];
      update({ ...initial(), sources: followed });
      return accepted({ source: replacement });
    });
    desk.wire.answer("skills.sources.remove", (params) => {
      if (!followed.some((held) => held.id === params.sourceId)) return { error: { code: "not_found", message: "No such source.", data: {} } };
      followed = followed.filter((held) => held.id !== params.sourceId);
      update({ ...initial(), sources: followed });
      return accepted({ source: moved });
    });
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    for (const folder of folders) await app.user.click(await within(card()).findByRole("checkbox", { name: `${folder} · 2 skills` }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    expect(await within(card()).findByText("agent-harness could not reach git.example.test.")).toBeDefined();
    expect(within(card()).getByText(/team\/procedures \(skills\) was removed to make room for its new folders\.$/)).toBeDefined();
    expect(desk.requests("skills.sources.remove")).toHaveLength(1);
    return { app, desk, replacement, followed: () => followed };
  };

  it("at the limit, a refused add after the moved collection made room is tried again without removing it twice", async () => {
    const { app, desk, replacement, followed } = await refusedAtLimit();
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    await waitFor(() => expect(desk.requests("skills.sources.add")).toHaveLength(2));
    expect(await within(card()).findByText(/^Added .*agents/)).toBeDefined();
    expect(desk.requests("skills.sources.remove")).toHaveLength(1);
    expect(followed().map((held) => held.id)).toContain(replacement.id);
  });

  it("at the limit, says the moved collection was removed when the add after it is refused, and still says so after Cancel", async () => {
    const { app } = await refusedAtLimit();
    await app.user.click(within(card()).getByRole("button", { name: "Cancel" }));
    expect(within(card()).queryByRole("checkbox", { name: "agents · 2 skills" })).toBeNull();
    expect(within(card()).getByText("team/procedures (skills) was removed to make room for its new folders.")).toBeDefined();
  });

  it("at the limit, a refused retry keeps saying the folders already added before the moved collection's removal, after Cancel", async () => {
    const { app, desk } = await refusedAtLimit({ folders: ["agents", "tools"], refused: 1 });
    desk.wire.answer("skills.sources.add", () => ({ error: { code: "conflict", message: "You can follow up to 20 collections. Remove one first.", data: { reason: "source_limit" } } }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    expect(await within(card()).findByText("You can follow up to 20 collections. Remove one first.")).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Cancel" }));
    expect(within(card()).getByText("Added team/procedures (agents). team/procedures (skills) was removed to make room for its new folders.")).toBeDefined();
  });

  it("reopened after its kept look is five minutes old, Choose folders looks at the repository once", async () => {
    const moved: SkillsViewSource = { ...source, url: linked, identity: linked, folder: "skills", skillCount: 0, sync: { outcome: "layout_moved", since: source.addedAt, commit: found.commit, folders: ["agents"] } };
    const { app, desk } = await opened({ ...initial(), sources: [moved] }, { setup: { skills: {
      state: "needs-attention", reason: "team/procedures (skills) no longer has skills where they were. Choose its folders again.", failing: ["skills.sources-yield"], actions: ["choose-folders"],
      targets: [{ action: "choose-folders", kind: "skill-source", id: moved.id, label: "team/procedures (skills)" }],
    } } });
    desk.wire.answer("skills.probe", () => ({ result: { ...found, folders: [{ ...found.folders[0]!, folder: "agents" }] } }));
    await app.user.click(await within(card()).findByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    expect(await within(card()).findByText("Found 1 skill folder:")).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Cancel" }));
    // Just past the five minutes a look stays fresh, the card's own read answered again on the way.
    act(() => app.clock.advance(5 * 60_000 + 1_000));
    await waitFor(() => expect(desk.requests("skills.get").length).toBeGreaterThan(1));
    await app.user.click(within(card()).getByRole("button", { name: "Choose folders: team/procedures (skills)" }));
    expect(await within(card()).findByText("Found 1 skill folder:")).toBeDefined();
    await act(async () => { await Promise.resolve(); });
    expect(desk.requests("skills.probe")).toHaveLength(2);
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
    expect(within(card()).getAllByText("Leaves Set up")).not.toHaveLength(0);
    await app.user.click(within(card()).getByRole("button", { name: "All skill settings" }));
    expect(within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: "Skills" })).toBeDefined();
  });
});

describe("the Skills card's Add from a link", () => {
  it("drops a selected folder absent from a repeated look and adds only a folder in the new result", async () => {
    const { app, desk } = await opened();
    let answer = found;
    desk.wire.answer("skills.probe", () => ({ result: answer }));
    await lookFor(app, linked);
    await app.user.click(await within(card()).findByRole("checkbox", { name: "skills · 2 skills" }));
    answer = { ...found, probeId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", folders: [{ ...found.folders[0]!, folder: "agents" }] };
    await app.user.click(within(card()).getByRole("button", { name: "Look for skills" }));
    const agents = await within(card()).findByRole("checkbox", { name: "agents · 2 skills" });
    expect((agents as HTMLInputElement).checked).toBe(false);
    expect(within(card()).queryByRole("checkbox", { name: "skills · 2 skills" })).toBeNull();
    const add = within(card()).getByRole("button", { name: "Add selected" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await app.user.click(add);
    expect(desk.requests("skills.sources.add")).toHaveLength(0);
    desk.wire.answer("skills.sources.add", (params) => {
      expect(params).toMatchObject({ folder: "agents", probeId: answer.probeId });
      return accepted({ source: { ...source, url: linked, identity: linked, folder: "agents" } });
    });
    await app.user.click(agents);
    await app.user.click(add);
    expect(await within(card()).findByText("Added team/procedures (agents).")).toBeDefined();
    expect(desk.requests("skills.sources.add")).toHaveLength(1);
  });

  it("keeps found folders and Add selected unavailable with a reason after the connection is lost", async () => {
    const { app, desk } = await opened();
    desk.wire.answer("skills.probe", () => ({ result: found }));
    await lookFor(app, linked);
    const panel = within(card()).getByRole("region", { name: "Add from a link" });
    const tick = await within(panel).findByRole("checkbox", { name: "skills · 2 skills" });
    await app.user.click(tick);
    expect((within(panel).getByRole("button", { name: "Add selected" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { desk.discovery("nothing"); desk.server.drop(); });
    await waitFor(() => expect((tick as HTMLInputElement).disabled).toBe(true));
    const add = within(panel).getByRole("button", { name: "Add selected" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect((tick as HTMLInputElement).checked).toBe(true);
    expect(within(panel).getAllByText("desk cannot be reached.").length).toBeGreaterThan(0);
    await app.user.click(add);
    expect(desk.requests("skills.sources.add")).toHaveLength(0);
    expect(desk.requests("skills.sources.remove")).toHaveLength(0);
  });

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

  it("says the folders added before a refused one, beside its refusal", async () => {
    const { app, desk } = await opened();
    desk.wire.answer("skills.probe", () => ({ result: { ...found, folders: [found.folders[0]!, { ...found.folders[0]!, folder: "tools" }] } }));
    const added = { ...source, id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", url: linked, identity: linked, folder: "skills", skillCount: 2 };
    desk.wire.answer("skills.sources.add", (params) => params.folder === "tools"
      ? unreachable("unreachable", "agent-harness could not reach git.example.test.", "fatal: unable to access")
      : accepted({ source: added }));
    await lookFor(app, linked);
    await app.user.click(await within(card()).findByRole("checkbox", { name: "skills · 2 skills" }));
    await app.user.click(within(card()).getByRole("checkbox", { name: "tools · 2 skills" }));
    await app.user.click(within(card()).getByRole("button", { name: "Add selected" }));
    expect(await within(card()).findByText("agent-harness could not reach git.example.test.")).toBeDefined();
    expect(within(card()).getByText("Added team/procedures (skills).")).toBeDefined();
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
