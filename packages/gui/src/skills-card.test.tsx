import { act, screen, waitFor, within } from "@testing-library/react";
import { CATALOGUE, whenWords, type SkillsView, type SkillsViewMember, type SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

const source: SkillsViewSource = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e", url: "https://github.com/theclaymethod/unslop", identity: "https://github.com/theclaymethod/unslop", folder: ".",
  follow: { kind: "branch", branch: "main" }, position: 1, addedBy: { kind: "client_session", id: "desk" }, addedAt: "2026-09-29T10:00:00.000Z",
  commit: "c".repeat(40), skillCount: 1, sync: { outcome: "ok", since: "2026-09-29T10:00:00.000Z" }, attemptedAt: "2026-09-29T10:00:00.000Z",
};
const initial = (): SkillsView => ({ ownDirectory: "/home/test/skills/own", sources: [], choices: [], accountId: "writer",
  accounts: [{ accountId: "writer", channel: "system-prompt-append", reason: null }], members: [] });
const accepted = (result: Record<string, unknown>) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result } });
const card = () => screen.getByRole("region", { name: "Skills" });
const opened = async (value = initial(), given: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ id: "writer", label: "Writer" }, { id: "editor", label: "Editor" }], ...given }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const desk = app.environment("desk");
  let skills = value;
  desk.wire.answer("skills.get", () => ({ result: skills }));
  desk.wire.answer("trust.list", () => ({ result: { trusted: [], declined: [] } }));
  await app.user.click(within(await screen.findByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Skills" }));
  return { app, desk, update: (next: SkillsView) => { skills = next; desk.notice("skills.updated", {}); } };
};

describe("the Skills card in Set up", () => {
  it("offers honest catalogue cards with nothing ticked and expands the invocation list", async () => {
    const { app, desk } = await opened();
    const unslop = await within(card()).findByRole("region", { name: "Unslop" });
    expect(within(unslop).getByText("1 skill(s)")).toBeDefined();
    expect(within(unslop).getByText("MIT — declared in SKILL.md frontmatter")).toBeDefined();
    expect(within(unslop).getByText(/no LICENSE file and names no copyright holder/)).toBeDefined();
    expect(within(unslop).getByText(/5924 characters, about 1481 tokens on every run/)).toBeDefined();
    expect(within(unslop).getByText("At most 20 sources.")).toBeDefined();
    const engineering = within(card()).getByRole("region", { name: "Matt Pocock — engineering" });
    expect(within(engineering).getByText("Changes often.")).toBeDefined();
    expect(within(engineering).getByText("MIT — LICENSE")).toBeDefined();
    for (const tick of within(card()).getAllByRole("checkbox")) expect((tick as HTMLInputElement).checked).toBe(false);
    expect(desk.requests("skills.sources.add")).toHaveLength(0);
    expect(desk.requests("skills.setAlwaysOn")).toHaveLength(0);
    await app.user.click(within(unslop).getByText("Show skills"));
    expect(within(unslop).getByText(/unslop: .*model\+slash/)).toBeDefined();
    for (const entry of CATALOGUE.skills) expect(within(card()).getByText(entry.pitch)).toBeDefined();
  });
});

it("ticks a catalogue entry into a source, derives its tick on revisit, and confirms unticking", async () => {
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
  const tick = await within(card()).findByRole("checkbox", { name: "Track Unslop" });
  await app.user.click(tick);
  const row = await within(card()).findByRole("region", { name: `${source.identity} — .` });
  expect(within(row).getByText("main")).toBeDefined();
  expect(within(row).getByText(source.commit)).toBeDefined();
  expect(within(row).getAllByText(source.attemptedAt ?? "")).toHaveLength(2);
  expect((tick as HTMLInputElement).checked).toBe(true);
  expect(desk.requests("skills.setAlwaysOn")).toHaveLength(0);
  await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Instructions" }));
  await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Skills" }));
  const revisited = await within(card()).findByRole("checkbox", { name: "Track Unslop" });
  await waitFor(() => expect((revisited as HTMLInputElement).checked).toBe(true));
  await app.user.click(revisited);
  expect(desk.requests("skills.sources.remove")).toHaveLength(0);
  const dialog = await screen.findByRole("dialog", { name: "Stop tracking Unslop" });
  await app.user.click(within(dialog).getByRole("button", { name: "Confirm remove source" }));
  await waitFor(() => expect((revisited as HTMLInputElement).checked).toBe(false));
});

it("pulls the sources named by the health result without leaving Set up", async () => {
  const { app, desk, update } = await opened({ ...initial(), sources: [source] }, { setup: { skills: {
    state: "needs-attention", reason: "The source failed to sync.", failing: ["skills.sources-synced"], actions: ["pull-now"],
    targets: [{ action: "pull-now", kind: "skill-source", id: source.id, label: "Unslop" }],
  } } });
  desk.wire.answer("skills.sources.pull", (params) => {
    expect(params.sourceId).toBe(source.id);
    update({ ...initial(), sources: [{ ...source, commit: "d".repeat(40) }] });
    return accepted({ source, layoutMoved: false });
  });
  const pull = await within(card()).findByRole("button", { name: "Update now: Unslop" });
  await app.user.click(pull);
  expect(await within(card()).findByText("d".repeat(40))).toBeDefined();
  expect(screen.getByRole("navigation", { name: "Set up steps" })).toBeDefined();
  expect(await within(card()).findByText("Unslop is up to date.")).toBeDefined();
  await app.user.click(within(card()).getByRole("button", { name: "Pull now" }));
  await waitFor(() => expect(desk.requests("skills.sources.pull")).toHaveLength(2));
});

it("offers always-on per account with its size and changes only the chosen account", async () => {
  const member: SkillsViewMember = {
    name: "unslop", kind: "skill", path: "unslop", description: "Remove machine-written prose.", invocation: "model+slash", userInvocable: true,
    argumentHint: null, whileActive: [], origin: { kind: "repository", repository: source.identity, path: "." }, layer: { kind: "source", sourceId: source.id },
    size: 5924, tokens: 1481, problems: [], warnings: [], shadowedBy: null, native: false, enabled: true, alwaysOn: false, choices: [],
  };
  const skills: SkillsView = { ...initial(), sources: [source], members: [member], accounts: [...initial().accounts, { accountId: "editor", channel: "system-prompt-append", reason: null }] };
  const { app, desk, update } = await opened(skills);
  desk.wire.answer("skills.setAlwaysOn", (params) => {
    expect(params).toMatchObject({ name: "unslop", accountId: "editor", on: true });
    const choice = { kind: "always-on", name: "unslop", accountId: "editor", on: true } as const;
    update({ ...skills, choices: [choice] });
    return accepted({ choice });
  });
  const editor = await within(card()).findByRole("switch", { name: "Every prompt unslop on Editor" });
  expect(editor.getAttribute("aria-checked")).toBe("false");
  const writer = within(card()).getByRole("switch", { name: "Every prompt unslop on Writer" });
  expect(writer.getAttribute("aria-checked")).toBe("false");
  expect(within(card()).getByText(/5924 characters · approximately 1481 tokens/)).toBeDefined();
  await app.user.click(editor);
  await waitFor(() => expect(editor.getAttribute("aria-checked")).toBe("true"));
  expect(writer.getAttribute("aria-checked")).toBe("false");
});

it("probes Add by URL and tracks the chosen root folder with its probe id and pin", async () => {
  const { app, desk, update } = await opened();
  desk.wire.answer("skills.probe", (params) => {
    expect(params.url).toBe(source.url);
    return { result: { probeId: source.id, identity: source.identity, branch: "main", commit: source.commit, root: {
      folder: ".", count: 1, licence: null, members: [{ name: "unslop", path: ".", description: "Remove prose patterns.", invocation: "model+slash", problems: [] }],
    }, folders: [], truncated: false } };
  });
  desk.wire.answer("skills.sources.add", (params) => {
    expect(params).toMatchObject({ url: source.url, folder: ".", probeId: source.id, follow: { kind: "pinned", commit: source.commit } });
    const pinned = { ...source, follow: { kind: "pinned", commit: source.commit } } as const;
    update({ ...initial(), sources: [pinned] });
    return accepted({ source: pinned });
  });
  expect(within(card()).getByRole("heading", { name: "Add by URL" })).toBeDefined();
  await app.user.type(within(card()).getByRole("textbox", { name: "Source URL" }), source.url);
  await app.user.click(within(card()).getByRole("button", { name: "Probe repository" }));
  await app.user.click(await within(card()).findByRole("checkbox", { name: "Track .: 1 skill(s)" }));
  await app.user.click(within(card()).getByRole("checkbox", { name: "Pin at this commit" }));
  await app.user.click(within(card()).getByRole("button", { name: "Track selected folders" }));
  expect(await within(card()).findByText("Pinned commit")).toBeDefined();
  expect((within(card()).getByRole("button", { name: "Pull now" }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect((within(card()).getByRole("checkbox", { name: "Track Unslop" }) as HTMLInputElement).checked).toBe(true));
});

it("lists a trusted repository with when and by whom, and revokes it for the next run", async () => {
  const { app, desk } = await opened();
  const record = { key: "https://git.example.test/david/notes", keyKind: "identity", decision: "trusted", decidedAt: "2026-09-29T10:00:00.000Z", clientSessionId: "desk", clientLabel: "Desk window", sessionId: null };
  let trusted = true;
  desk.wire.answer("trust.list", () => ({ result: { trusted: trusted ? [record] : [], declined: [] } }));
  desk.wire.answer("trust.revoke", (params) => {
    expect(params.key).toBe(record.key);
    trusted = false;
    desk.notice("trust.updated", {});
    return accepted({ record });
  });
  act(() => desk.notice("trust.updated", {}));
  const row = await within(card()).findByRole("region", { name: `Trusted: ${record.key}` });
  expect(within(row).getByText(`Trusted ${whenWords(record.decidedAt, app.clock.now())} by Desk window`)).toBeDefined();
  expect(within(card()).getByText(/Trust also admits project settings, permission rules and hooks/)).toBeDefined();
  await app.user.click(within(row).getByRole("button", { name: "Revoke trust" }));
  expect(await within(card()).findByText("No repository is trusted on this environment.")).toBeDefined();
});

it("refuses a twenty-first catalogue source on one line and leaves it unticked", async () => {
  const sources = Array.from({ length: 20 }, (_, index) => ({ ...source, id: `0f8fad5b-d9cb-469f-a165-${String(index).padStart(12, "0")}`, identity: "https://git.example.test/david/skills", url: "https://git.example.test/david/skills", folder: `skills-${index}`, position: index + 1 }));
  const { app, desk } = await opened({ ...initial(), sources });
  desk.wire.answer("skills.sources.add", () => ({ error: { code: "conflict", message: "At most 20 sources.\nRemove a source first.", data: { reason: "source_limit" } } }));
  const tick = await within(card()).findByRole("checkbox", { name: "Track Unslop" });
  await app.user.click(tick);
  expect(await within(card()).findByRole("status")).toHaveProperty("textContent", "At most 20 sources. Remove a source first.");
  expect((tick as HTMLInputElement).checked).toBe(false);
  expect(desk.requests("skills.sources.add")).toHaveLength(1);
});

it("keeps catalogue ticks read-only with the capability reason and shows cached sources as stale after disconnect", async () => {
  const { app, desk } = await opened({ ...initial(), sources: [source] }, { scopes: ["read"] });
  const tick = await within(card()).findByRole("checkbox", { name: "Track Unslop" });
  await waitFor(() => expect((tick as HTMLInputElement).checked).toBe(true));
  expect((tick as HTMLInputElement).disabled).toBe(true);
  expect(within(card()).getAllByText(/change settings or sign in accounts/).length).toBeGreaterThan(0);
  desk.discovery("nothing");
  desk.server.drop();
  expect(await within(card()).findByText(/^Stale:/)).toBeDefined();
  expect(within(card()).getByText(source.commit)).toBeDefined();
  expect((tick as HTMLInputElement).checked).toBe(true);
  expect((tick as HTMLInputElement).disabled).toBe(true);
  expect(app.presentation.values.read()).not.toHaveProperty("skills");
});
