import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { organisationFixture } from "../../test/organisation-fixture.js";

const { tempDir, onCleanup } = useCleanups();
const fixture = () => organisationFixture(tempDir);

it("unions provider archive tags and desktop keys, and qualified desktop and bare terminal pins after Session mapping", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ archivedSessions: [`work:${f.ids[1]}`], pinnedSessions: [`work:${f.ids[2]}`] }));
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2], "missing"] } }));
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const a = await t.client();
  const b = await t.client();
  const answer = await a.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(answer.result).toMatchObject({ carried: { archived: 2, pins: 1 }, failed: [], notCarried: [{ label: "Unknown Session references", count: 1, step: "carry-over" }] });
  const summaries = (await b.request("sessions.list", {})).sessions;
  expect(summaries.filter((s) => s.archivedAt !== null)).toHaveLength(2);
  expect(summaries.find((s) => s.pinnedAt !== null)?.title).toBe("Session 2");
  const pinned = summaries.find((s) => s.pinnedAt !== null)!;
  await b.request("sessions.unpin", { commandId: randomUUID(), sessionId: pinned.id });
  expect((await a.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.carried).toMatchObject({ archived: 0, pins: 0 });
  expect((await b.request("sessions.get", { sessionId: pinned.id })).summary.pinnedAt).toBeNull();
});

it("never attaches an ambiguous bare id or an unknown qualified Account to another Account's Session", async () => {
  const f = fixture();
  const other = tempDir();
  writeFileSync(join(other, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "other@example.com" } }));
  const profiles = JSON.parse(readFileSync(join(f.source, "profiles.json"), "utf8")) as { profiles: unknown[] };
  writeFileSync(join(f.source, "profiles.json"), JSON.stringify({ version: 2, profiles: [...profiles.profiles, { id: "other", label: "Other", providerId: "claude", configDir: other }] }));
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ pinnedSessions: [`missing:${f.ids[2]}`, `work:${f.ids[1]}`] }));
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2], "missing", 42] } }));
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  const answer = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect((await client.request("sessions.list", {})).sessions).toHaveLength(6);
  expect(answer.result).toMatchObject({ carried: { pins: 1 }, notCarried: expect.arrayContaining([
    { label: "Ambiguous Session references", count: 1, step: "carry-over" },
    { label: "Unknown Session references", count: 2, step: "carry-over" },
    { label: "Invalid organisation entries", count: 1, step: "carry-over" },
  ]) });
  const summaries = (await client.request("sessions.list", {})).sessions;

  expect(summaries.filter((s) => s.pinnedAt !== null)).toMatchObject([{ title: "Session 1" }]);
});

it("merges normalised Group names, appends in source order, and holds memberships and deleted Groups across source reordering and restart", async () => {
  const f = fixture();
  const dataDir = tempDir();
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ sessionGroups: [{ id: "merge", name: "  EXISTING   work " }, { id: "second", name: "Second" }, { id: "third", name: "Third" }], sessionGroupOf: { [`work:${f.ids[1]}`]: "merge", [`work:${f.ids[2]}`]: "second" } }));
  const t = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => t.close());
  const a = await t.client();
  const existing = randomUUID();
  const first = randomUUID();
  await a.request("groups.create", { commandId: randomUUID(), id: first, name: "First", orderKey: "m" });
  await a.request("groups.create", { commandId: randomUUID(), id: existing, name: "Existing work" });
  expect((await a.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toMatchObject({ carried: { groups: 2 }, failed: [] });
  const groups = (await a.request("groups.list", {})).groups;
  expect(groups.map((g) => g.name)).toEqual(["First", "Existing work", "Second", "Third"]);
  const summaries = (await a.request("sessions.list", {})).sessions;
  expect(summaries.find((s) => s.title === "Session 1")?.groupId).toBe(existing);
  const member = summaries.find((s) => s.title === "Session 2")!;
  await a.request("sessions.setGroup", { commandId: randomUUID(), sessionId: member.id, groupId: existing });
  await a.request("groups.delete", { commandId: randomUUID(), groupId: groups[2]!.id });
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ sessionGroups: [{ id: "different", name: "Second" }, { id: "third", name: "Renamed Third" }, { id: "merge", name: "Existing work" }, { id: "new", name: "New" }], sessionGroupOf: { [`work:${f.ids[2]}`]: "different" } }));
  await t.close();
  const restarted = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => restarted.close());
  const b = await restarted.client();
  await b.request("environment.rebuildProjections", { commandId: randomUUID() });
  expect((await b.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toMatchObject({ carried: { groups: 1 }, failed: [] });
  expect((await b.request("groups.list", {})).groups.map((g) => g.name)).toEqual(["First", "Existing work", "Third", "New"]);
  expect((await b.request("sessions.get", { sessionId: member.id })).summary.groupId).toBe(existing);
});

it("fills only empty drafts, rechecks a competing edit at commit, and holds successful mappings after source text changes", async () => {
  const f = fixture();
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2]], drafts: [{ sessionId: f.ids[1], text: "Carried draft" }, { sessionId: f.ids[2], text: "Source race" }] } }));
  let raced = false;
  const t = await startTestEnvironment({ ...f.options, stateImportHooks: { carried: async (item) => {
    if (item.kind !== "pin" || raced) return;
    raced = true;
    const session = (await competing.request("sessions.list", {})).sessions.find((s) => s.title === "Session 2")!;
    await competing.request("sessions.setDraft", { commandId: randomUUID(), sessionId: session.id, draft: "Harness race wins" });
  } } });
  onCleanup(() => t.close());
  const a = await t.client();
  const competing = await t.client();
  const answer = await a.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(answer.result).toMatchObject({ carried: { drafts: 1 }, failed: [] });
  const sessions = (await competing.request("sessions.list", {})).sessions;
  expect(sessions.find((s) => s.title === "Session 1")?.draft).toBe("Carried draft");
  expect(sessions.find((s) => s.title === "Session 2")?.draft).toBe("Harness race wins");
  const first = sessions.find((s) => s.title === "Session 1")!;
  await competing.request("sessions.setDraft", { commandId: randomUUID(), sessionId: first.id, draft: null });
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { drafts: [{ sessionId: f.ids[1], text: "Source changed" }, { sessionId: f.ids[2], text: "Overwrite?" }, { sessionId: "missing", text: "Retry me" }, { sessionId: 42, text: false }] } }));
  expect((await a.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toMatchObject({ carried: { drafts: 0 }, failed: [], notCarried: expect.arrayContaining([
    { label: "Unknown Session references", count: 1, step: "carry-over" }, { label: "Invalid organisation entries", count: 1, step: "carry-over" },
  ]) });
  expect((await competing.request("sessions.get", { sessionId: first.id })).summary.draft).toBeNull();
});

it("archives ledger program/bridge and ephemeral Workspaces and uncontinued Routine firings, while SDK-reported later prompts stay active without transcript reads", async () => {
  const f = fixture();
  const extra = [randomUUID(), randomUUID(), randomUUID()];
  f.listing[0] = { ...f.listing[0]!, tag: null };
  f.listing[1] = { ...f.listing[1]!, firstPrompt: '<scheduled-task name="fixture">Check the repo' };
  f.listing[2] = { ...f.listing[2]!, firstPrompt: "Please continue with my change" };
  f.listing.push(...extra.map((providerSessionId, i) => ({ ...f.listing[0]!, providerSessionId, summary: `Ledger ${i}` })));
  let reads = 0;
  Object.assign(f.options.otherAdapters[0]!, { readHistory: async () => { reads++; throw new Error("Listing/import must not read transcripts."); } });
  writeFileSync(join(f.source, "serverSessions.json"), JSON.stringify({ version: 2, entries: [
    { sessionId: extra[0], profileId: "work", origin: "program", workspaceKey: "dir:/fixture", at: 1 },
    { sessionId: extra[1], profileId: "work", origin: "bridge", workspaceKey: "dir:/fixture", at: 1 },
    { sessionId: extra[2], profileId: "work", workspaceKey: "conn:fixture", at: 1 },
  ] }));
  writeFileSync(join(f.source, "routines.json"), JSON.stringify({ routines: [{ id: "routine", name: "Fixture checks", cwd: f.directory, createdAt: 1, schedule: { kind: "manual" }, permissionMode: "bypassPermissions", providerId: "claude", profileId: "work", instructions: "Check the repo", history: [{ sessionId: f.ids[1] }, { sessionId: f.ids[2] }] }] }));
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  const inventory = await client.request("carryOver.inventory", { source: "state-import" });
  expect(inventory).toMatchObject({ accounts: [{ inventory: { sessions: { archived: 1 } } }] });
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).result?.carried.archived).toBe(4);
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toMatchObject({ carried: { archived: 4 }, failed: [] });
  const summaries = (await client.request("sessions.list", {})).sessions;
  expect(summaries.find((s) => s.title === "Session 2")?.archivedAt).toBeNull();
  expect(summaries.find((s) => s.title === "Session 1")?.archivedAt).not.toBeNull();
  expect(summaries.filter((s) => s.title.startsWith("Ledger")).every((s) => s.archivedAt !== null)).toBe(true);
  expect(reads).toBe(0);
});

it("keeps deleted mapped Sessions absent and retries unknown references and repaired stores on a fresh command", async () => {
  const f = fixture();
  const dataDir = tempDir();
  writeFileSync(join(f.terminal, "preferences.json"), "malformed");
  const t = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => t.close());
  const client = await t.client();
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toMatchObject([{ label: "Terminal organisation" }]);
  const doomed = (await client.request("sessions.list", {})).sessions.find((s) => s.title === "Session 2")!;
  await client.request("sessions.delete", { commandId: randomUUID(), sessionId: doomed.id });
  await client.request("sessions.purge", { commandId: randomUUID(), sessionId: doomed.id });
  const newId = randomUUID();
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2], newId] } }));
  const omitted = (await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result!;
  expect(omitted.failed).toEqual([]);
  expect(omitted.notCarried).toEqual(expect.arrayContaining([{ label: "Held organisation entries", count: 1, step: "carry-over" }, { label: "Unknown Session references", count: 1, step: "carry-over" }]));
  f.listing.push({ ...f.listing[2]!, providerSessionId: newId, summary: "New Session" });
  await t.close();
  const restarted = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => restarted.close());
  const next = await restarted.client();
  expect((await next.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).result?.carried.pins).toBe(1);
  expect((await next.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.carried.pins).toBe(1);
  const sessions = (await next.request("sessions.list", {})).sessions;
  expect(sessions).toHaveLength(3);
  expect(sessions.find((s) => s.id === doomed.id)).toBeUndefined();
  expect(sessions.find((s) => s.title === "New Session")?.pinnedAt).not.toBeNull();
});

it("refuses changed preference bytes independently, and a later import pins through the shelf companions without overwriting a held draft", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ pinnedSessions: [`work:${f.ids[2]}`], sessionGroups: [{ id: "source", name: "Source" }] }));
  let change = true;
  const t = await startTestEnvironment({ ...f.options, stateImportHooks: { planned: () => { if (change) writeFileSync(join(f.source, "prefs.json"), "{}"); } } });
  onCleanup(() => t.close());
  const client = await t.client();
  const first = (await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result!;
  expect(first.failed).toEqual(expect.arrayContaining([{ label: "Desktop organisation", message: "It changed after it was read: preview again, then import." }]));
  expect(first.carried).toMatchObject({ pins: 0, groups: 0 });
  const session = (await client.request("sessions.list", {})).sessions.find((s) => s.title === "Session 2")!;
  await client.request("sessions.settle", { commandId: randomUUID(), sessionId: session.id });
  await client.request("sessions.snooze", { commandId: randomUUID(), sessionId: session.id, until: "2026-09-25T00:00:00.000Z" });
  await client.request("sessions.setDraft", { commandId: randomUUID(), sessionId: session.id, draft: "Existing harness draft" });
  change = false;
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2]], drafts: [{ sessionId: f.ids[2], text: "Source draft" }] } }));
  const preview = (await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).result!;
  expect(preview.carried).toMatchObject({ pins: 1, drafts: 0 });
  expect(preview.notCarried).toContainEqual({ label: "Held drafts", count: 1, step: null });
  const imported = (await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result!;
  expect(imported).toEqual({ ...preview, dryRun: false });
  expect((await client.request("sessions.get", { sessionId: session.id })).summary).toMatchObject({ settledAt: null, snoozedUntil: null, draft: "Existing harness draft", pinnedAt: "2026-09-24T00:00:00.000Z" });
});

it("retains committed organisation mappings through a crash and finishes the remaining entries after restart", async () => {
  const f = fixture();
  const dataDir = tempDir();
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2]], drafts: [{ sessionId: f.ids[2], text: "Draft after crash" }] } }));
  const t = await startTestEnvironment({ ...f.options, dataDir, stateImportHooks: { carried: (item) => { if (item.kind === "pin") throw new Error("Crash after pin commit"); } } });
  onCleanup(() => t.close());
  const client = await t.client();
  await expect(client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).rejects.toMatchObject({ code: "internal" });
  const session = (await client.request("sessions.list", {})).sessions.find((s) => s.title === "Session 2")!;
  expect(session.pinnedAt).not.toBeNull();
  expect(session.draft).toBeNull();
  await client.request("sessions.unpin", { commandId: randomUUID(), sessionId: session.id });
  await t.close();
  const restarted = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => restarted.close());
  const next = await restarted.client();
  expect((await next.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toMatchObject({ carried: { pins: 0, drafts: 1 }, failed: [] });
  expect((await next.request("sessions.get", { sessionId: session.id })).summary).toMatchObject({ pinnedAt: null, draft: "Draft after crash" });
});

it("rechecks organisation bytes after provider Sessions commit before applying their references", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ pinnedSessions: [`work:${f.ids[2]}`] }));
  const t = await startTestEnvironment({ ...f.options, stateImportHooks: { carried: (item) => { if (item.kind === "session") writeFileSync(join(f.source, "prefs.json"), "{}"); } } });
  onCleanup(() => t.close());
  const client = await t.client();
  const report = (await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result!;
  expect(report.carried.pins).toBe(0);
  expect(report.failed).toContainEqual({ label: "Desktop organisation", message: "It changed after it was read: preview again, then import." });
  expect((await client.request("sessions.list", {})).sessions.every((s) => s.pinnedAt === null)).toBe(true);
});

it("recognises an uncontinued source Routine when the SDK normalises and truncates its first prompt", async () => {
  const f = fixture();
  const instructions = "Check\n" + "the repo ".repeat(40);
  f.listing[1] = { ...f.listing[1]!, firstPrompt: "Check " + "the repo ".repeat(21) + "the r…" };
  writeFileSync(join(f.source, "routines.json"), JSON.stringify({ routines: [{ id: "routine", name: "Fixture checks", cwd: f.directory, createdAt: 1, schedule: { kind: "manual" }, permissionMode: "bypassPermissions", providerId: "claude", profileId: "work", instructions, history: [{ sessionId: f.ids[1] }] }] }));
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect((await client.request("sessions.list", {})).sessions.find((s) => s.title === "Session 1")?.archivedAt).not.toBeNull();
});
