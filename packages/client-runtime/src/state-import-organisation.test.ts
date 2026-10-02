import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { organisationFixture } from "../../environment/test/organisation-fixture.js";
import { useHarness, holds, originOf } from "../test/harness.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();
it("both Clients receive identical archive, pins, Groups and drafts through subscriptions, then replay and restart with harness edits intact", async () => {
  const f = organisationFixture(harness.tempDir);
  const dataDir = harness.tempDir();
  const other = harness.tempDir();
  const ambiguous = randomUUID();
  f.listing[1] = { ...f.listing[1]!, firstPrompt: '<scheduled-task name="fixture">Check' };
  f.listing[2] = { ...f.listing[2]!, firstPrompt: "Please continue" };
  const duplicate = { ...f.listing[2]!, providerSessionId: ambiguous, summary: "Shared id" };
  f.listing.push(duplicate);
  Object.assign(f.options.otherAdapters[0]!, { listSessions: async (account: { directory: string | null }) => account.directory === other ? [duplicate] : f.listing });
  writeFileSync(join(other, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "other@example.com" } }));
  writeFileSync(join(f.source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: "work", label: "Work", providerId: "claude", configDir: f.directory },
    { id: "other", label: "Other", providerId: "claude", configDir: other },
  ] }));
  writeFileSync(join(f.source, "serverSessions.json"), JSON.stringify({ version: 2, entries: [
    { sessionId: f.ids[0], profileId: "work", origin: "program", workspaceKey: "conn:fixture", at: 1 },
    { sessionId: f.ids[1], profileId: "work", origin: "bridge", workspaceKey: "dir:/fixture", at: 1 },
    { sessionId: f.ids[2], profileId: "work", origin: "program", workspaceKey: "conn:fixture", at: 1 },
  ] }));
  writeFileSync(join(f.source, "routines.json"), JSON.stringify({ routines: [{ id: "routine", providerId: "claude", profileId: "work", instructions: "Check", history: [{ sessionId: f.ids[1] }, { sessionId: f.ids[2] }] }] }));
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ archivedSessions: [`work:${f.ids[1]}`], pinnedSessions: [`work:${f.ids[2]}`], sessionGroups: [{ id: "work", name: "Work" }], sessionGroupOf: { [`work:${f.ids[2]}`]: "work" } }));
  writeFileSync(join(f.terminal, "preferences.json"), JSON.stringify({ version: 1, preferences: { pinned: [f.ids[2], ambiguous], drafts: [{ sessionId: f.ids[1], text: "Source race" }, { sessionId: f.ids[2], text: "Source draft" }] } }));
  const t = await harness.environment({ ...f.options, dataDir, stateImportHooks: { carried: async (item) => {
    if (item.kind !== "pin") return;
    const session = (await competing.request("sessions.list", {})).sessions.find((s) => s.title === "Session 1")!;
    await competing.request("sessions.setDraft", { commandId: randomUUID(), sessionId: session.id, draft: "Harness race" });
  } } });
  const competing = await t.client();
  const platforms = [inMemoryPlatform({ kind: "desktop" }), inMemoryPlatform({ kind: "tui" })];
  const runtimes = platforms.map((p) => harness.runtime(p));
  for (const runtime of runtimes) {
    await runtime.start();
    expect((await runtime.connections.add({ link: (await t.createPairing()).link })).status).toBe("paired");
  }
  const client = await t.client();
  const changed = runtimes.map((r) => holds(r.projections.sessionList, (v) => v.rows.some((row) => row.summary.draft === "Source draft" && row.groupName === "Work")));
  const report = (await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result!;
  expect(report.notCarried).toContainEqual({ label: "Ambiguous Session references", count: 1, step: "carry-over" });
  const views = await Promise.all(changed);
  const summary = (v: typeof views[number]) => v.rows.map(({ summary: s, groupName }) => ({ id: s.id, title: s.title, archivedAt: s.archivedAt, pinnedAt: s.pinnedAt, groupName, draft: s.draft })).sort((a, b) => a.title.localeCompare(b.title));
  expect(summary(views[0]!)).toEqual(summary(views[1]!));
  expect(views[0]!.archived).toHaveLength(2);
  expect(views[0]!.rows.find((r) => r.summary.title === "Session 1")?.summary.draft).toBe("Harness race");
  const pinned = views[0]!.pinned[0]!.summary;
  await runtimes[1]!.connections.setEnabled(t.env.id, false);
  const edited = holds(runtimes[0]!.projections.sessionList, (v) => v.rows.some((r) => r.summary.id === pinned.id && r.summary.draft === "Harness draft" && r.summary.pinnedAt === null));
  await client.request("sessions.unpin", { commandId: randomUUID(), sessionId: pinned.id });
  await client.request("sessions.setDraft", { commandId: randomUUID(), sessionId: pinned.id, draft: "Harness draft" });
  await edited;
  const replayed = holds(runtimes[1]!.projections.sessionList, (v) => v.rows.some((r) => r.summary.id === pinned.id && r.summary.draft === "Harness draft" && r.summary.pinnedAt === null));
  await runtimes[1]!.connections.setEnabled(t.env.id, true);
  await replayed;
  await Promise.all(runtimes.map((r) => r.close()));
  await t.close();
  const restarted = await harness.environment({ ...f.options, dataDir });
  const next = platforms.map((p) => harness.runtime(p));
  for (const runtime of next) {
    await runtime.start();
    await runtime.connections.setAddress(restarted.env.id, originOf(restarted.address));
    const view = await holds(runtime.projections.sessionList, (v) => v.environments.some((e) => e.environmentId === restarted.env.id && e.freshness === "live") && v.rows.some((r) => r.summary.id === pinned.id && r.summary.draft === "Harness draft"));
    expect(view.rows.find((r) => r.summary.id === pinned.id)?.groupName).toBe("Work");
    expect(view.rows.find((r) => r.summary.id === pinned.id)?.summary.pinnedAt).toBeNull();
  }
  const importAgain = await (await restarted.client()).request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(importAgain.result?.carried).toMatchObject({ archived: 0, pins: 0, groups: 0, drafts: 0 });
});
