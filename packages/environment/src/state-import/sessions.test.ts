import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registry, SessionSnapshot, type SessionCreatedPayload } from "@agent-harness/contracts";
import { end, fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { createProviderTranscriptStore } from "../provider-transcripts/store.js";
import { manualClock } from "../../test/clock.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { create, deleteSession, purgeSession, rename } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";
import { autoMemoryName } from "../workspace/auto-memory.js";
import { createClaudeAdapter } from "../adapters/claude/index.js";
import { machinePointedAt } from "./source/folders.js";

const { tempDir, onCleanup } = useCleanups();

const fixture = () => {
  const source = tempDir();
  const winner = tempDir();
  const secondary = tempDir();
  const workspace = tempDir();
  const shared = randomUUID();
  const secondaryOnly = randomUUID();
  const transcript = (directory: string, id: string, text: string, seconds: number) => {
    const project = join(directory, "projects", "fixture-project");
    mkdirSync(project, { recursive: true });
    const path = join(project, `${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "user", uuid: randomUUID(), parentUuid: null, sessionId: id, cwd: workspace, timestamp: "2026-09-01T00:00:00.000Z", isSidechain: false, message: { role: "user", content: text } }) + "\n");
    utimesSync(path, seconds, seconds);
    return path;
  };
  for (const directory of [winner, secondary]) writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "fixture@example.com" } }));
  transcript(winner, shared, "Winning history", 2000);
  transcript(secondary, shared, "Duplicate history", 1000);
  const path = transcript(secondary, secondaryOnly, "Secondary history", 1000);
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: "winner", label: "Winner", providerId: "claude", configDir: winner, publicEnv: {} },
    { id: "secondary", label: "Secondary", providerId: "claude", configDir: secondary, publicEnv: {} },
  ] }));
  const home = tempDir();
  const adapter = createClaudeAdapter({ hostEnv: { HOME: home }, runCommand: async () => { throw new Error("No provider process during import."); } });
  Object.assign(adapter, { status: async () => signedInAs("fixture@example.com") });
  const options = { accounts: [], otherAdapters: [adapter], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home }), carryOverHome: home };
  return { source, winner, secondary, shared, secondaryOnly, path, workspace, adapter, options };
};

it("previews both directories without adoption, imports records lazily under the winner, and preserves once-only secondary history and purged mappings across restart", async () => {
  const f = fixture();
  const bytes = readFileSync(f.path, "utf8");
  const dataDir = tempDir();
  const t = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => t.close());
  const a = await t.client();
  const b = await t.client();
  const previews = await a.request("carryOver.inventory", { source: "state-import" });
  expect(previews).toMatchObject({ accounts: [
    { sourceId: "secondary", inventory: { sessions: { total: 2 } } },
    { sourceId: "winner", inventory: { sessions: { total: 1 } } },
  ] });
  expect(await a.request("accounts.list", {})).toEqual({ accounts: [] });
  expect((await a.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  const { accounts } = await a.request("accounts.list", {});
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.directory.path).toBe(f.winner);
  const created = t.env.log.readStream({ kinds: ["session"] }).filter((e) => e.type === "session.created");
  expect(created).toHaveLength(2);
  const secondary = created.find((e) => (e.payload as SessionCreatedPayload).origin?.providerSessionId === f.secondaryOnly)!;
  expect(secondary.payload).toMatchObject({ account: accounts[0]?.id, origin: { sourceDirectory: f.secondary } });
  expect(t.env.log.readStream({ kinds: ["session"] }).filter((e) => e.type === "message.sent")).toHaveLength(0);
  const opens = await Promise.all([a, b].map((c) => c.subscribe("sessions.subscribeSession", { sessionId: secondary.streamId, afterSequence: t.env.log.head() + 1000 })));
  const snapshots = await Promise.all(opens.map(async ({ subscription }, i) => {
    const frame = await [a, b][i]!.next((e) => e.type === "snapshot" && e.subscription === subscription);
    if (frame.type !== "snapshot") throw new Error("Expected a snapshot.");
    return SessionSnapshot.parse(frame.payload);
  }));
  for (const snapshot of snapshots) expect(snapshot.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "user-message", text: "Secondary history" })]));
  expect(t.env.log.readStream({ kind: "session", id: secondary.streamId }).filter((e) => e.type === "session.history-imported")).toHaveLength(1);
  const shared = created.find((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId === f.shared)!;
  const openedShared = await a.subscribe("sessions.subscribeSession", { sessionId: shared.streamId, afterSequence: t.env.log.head() + 1000 });
  await a.next((frame) => frame.type === "snapshot" && frame.subscription === openedShared.subscription);
  await deleteSession(a, secondary.streamId);
  expect((await purgeSession(a, secondary.streamId)).receipt.status).toBe("accepted");
  await t.close();
  const restarted = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => restarted.close());
  const c = await restarted.client();
  expect((await c.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  expect(restarted.env.log.readStream({ kinds: ["session"] }).filter((e) => e.type === "session.created")).toHaveLength(1);
  const reopened = await c.subscribe("sessions.subscribeSession", { sessionId: shared.streamId, afterSequence: restarted.env.log.head() + 1000 });
  const frame = await c.next((event) => event.type === "snapshot" && event.subscription === reopened.subscription);
  if (frame.type !== "snapshot") throw new Error("Expected a snapshot.");
  expect(SessionSnapshot.parse(frame.payload).items).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Winning history" })]));
  expect(restarted.env.log.readStream({ kind: "session", id: shared.streamId }).filter((event) => event.type === "session.history-imported")).toHaveLength(1);
  expect(readFileSync(f.path, "utf8")).toBe(bytes);
});


it("keeps a missing secondary Workspace read-only, repairs it through the owner, and refuses continuation until retained history can hydrate the store", async () => {
  const f = fixture();
  rmSync(f.workspace, { recursive: true });
  const boundary = fakeAdapter({ script: () => [{ type: "session.provider-linked", payload: { providerSessionId: f.secondaryOnly } }, end()] });
  Object.assign(f.adapter, { createRun: boundary.createRun.bind(boundary) });
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  const created = t.env.log.readStream({ kinds: ["session"] }).find((e) => e.type === "session.created" && (e.payload as SessionCreatedPayload).origin?.providerSessionId === f.secondaryOnly)!;
  const sessionId = created.streamId;
  expect((await client.request("sessions.get", { sessionId })).summary.workspaceMissingSince).not.toBeNull();
  await client.request("accounts.refresh", {});
  const start = () => client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Continue" });
  expect((await start()).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "workspace_missing" } } });
  expect((await client.request("sessions.setWorkspace", { commandId: randomUUID(), sessionId, workspace: { kind: "directory", path: tempDir() } })).receipt.status).toBe("accepted");
  await expect(start()).rejects.toMatchObject({ code: "conflict", data: { reason: "import_source_unavailable" }, message: expect.stringContaining("read-only") });
  expect(boundary.runs).toHaveLength(0);
  const store = createProviderTranscriptStore({ log: t.env.log, clock: manualClock() });
  const seeded = createClaudeAdapter({ sessionStore: store });
  Object.assign(f.adapter, { seedSessionStore: seeded.seedSessionStore?.bind(seeded) });
  const original = readFileSync(f.path, "utf8");
  rmSync(f.path);
  await expect(start()).rejects.toMatchObject({ code: "conflict", data: { reason: "import_source_unavailable" } });
  expect(boundary.runs).toHaveLength(0);
  writeFileSync(f.path, original);
  const accepted = registry["runs.start"].response.parse(await start());
  expect(accepted.receipt.status).toBe("accepted");
  const chronology = t.env.log.readStream({ kind: "session", id: sessionId });
  const history = chronology.find((event) => event.type === "session.history-imported");
  expect(history?.sequence).toBeLessThan(chronology.find((event) => event.type === "run.started")!.sequence);
  await expect.poll(() => boundary.runs.length, { timeout: WAIT_MS }).toBe(1);
  expect(boundary.lastRun().input).toMatchObject({ account: { directory: f.winner }, target: { kind: "resume", providerSessionId: f.secondaryOnly, sourceDirectory: f.secondary } });
  expect((await store.load({ projectKey: sessionId, sessionId: f.secondaryOnly }))?.[0]?.message).toMatchObject({ content: "Secondary history" });
  await expect.poll(() => t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended"), { timeout: WAIT_MS }).toBe(true);
  rmSync(f.path);
  expect((await start()).receipt.status).toBe("accepted");
  await expect.poll(() => boundary.runs.length, { timeout: WAIT_MS }).toBe(2);
  expect(boundary.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: f.secondaryOnly });
  await expect.poll(() => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended").length, { timeout: WAIT_MS }).toBe(2);
});


it("defaults to carrying secondary memory and skills, keeps tracked-checkout offers and copies changed memory beside harness edits", async () => {
  const f = fixture();
  const memory = join(f.secondary, "projects", "fixture-project", "memory");
  const skill = join(f.secondary, "skills", "fixture-skill");
  const tracked = join(f.secondary, "skills", "tracked-skill");
  for (const directory of [memory, skill, tracked]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "Source memory\n");
  writeFileSync(join(skill, "SKILL.md"), "---\nname: fixture-skill\ndescription: A fixture skill.\n---\nSource skill.\n");
  writeFileSync(join(tracked, "SKILL.md"), "---\nname: tracked-skill\ndescription: A tracked fixture.\n---\nTracked skill.\n");
  git(tracked, "init", "-q", "-b", "main");
  git(tracked, "add", ".");
  git(tracked, "commit", "-q", "-m", "fixture");
  git(tracked, "remote", "add", "origin", "https://git.example.com/fixture/skills.git");
  const sourceSkill = readFileSync(join(skill, "SKILL.md"), "utf8");
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  const preview = await client.request("carryOver.inventory", { source: "state-import" });
  if (!("accounts" in preview)) throw new Error("Expected listed-source inventories.");
  expect(preview.accounts.find((account) => account.sourceId === "secondary")?.inventory).toMatchObject({ memory: { folders: 1 }, skills: { skills: 2, offered: [expect.objectContaining({ name: "tracked-skill" })] } });
  const target = join(t.dataDir, "auto-memory", autoMemoryName({ workspace: { kind: "directory", path: f.workspace }, repositoryIdentity: null }));
  expect(existsSync(join(target, "MEMORY.md"))).toBe(false);
  expect((await client.request("skills.get", {})).members).toEqual([]);
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toBe("Source memory\n");
  expect((await client.request("skills.get", {})).members.map((member) => member.name)).toContain("fixture-skill");
  const carried = t.env.log.readStream({ kinds: ["environment"] }).filter((event) => event.type === "carry-over.imported");
  expect(carried).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ skills: expect.objectContaining({ offered: [expect.objectContaining({ name: "tracked-skill" })] }) }) })]));
  writeFileSync(join(target, "MEMORY.md"), "Harness edits\n");
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toBe("Harness edits\n");
  writeFileSync(join(memory, "MEMORY.md"), "Changed source memory\n");
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toContain("Harness edits\n");
  expect(readFileSync(join(target, "carried", "fixture-project", "MEMORY.md"), "utf8")).toBe("Changed source memory\n");
  expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("Changed source memory\n");
  expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(sourceSkill);
});

it("preserves a committed winner source across a crash, retries secondary sources, and holds the shared coordinator against a second Client", async () => {
  const f = fixture();
  const dataDir = tempDir();
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const t = await startTestEnvironment({ ...f.options, dataDir, stateImportHooks: { carried: async (item) => {
    if (item.kind !== "session") return;
    entered();
    await held;
    throw new Error("Crash after the winner source committed.");
  } } });
  onCleanup(() => t.close());
  const a = await t.client();
  const b = await t.client();
  const running = a.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  const failed = expect(running).rejects.toMatchObject({ code: "internal" });
  await reached;
  try {
    const accountId = (await b.request("accounts.list", {})).accounts[0]!.id;
    expect((await b.request("carryOver.run", { commandId: randomUUID(), accountId, dryRun: false, skills: true })).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "import_in_progress" } } });
    expect((await b.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "import_in_progress" } } });
  } finally { release(); }
  await failed;
  const before = t.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created");
  expect(before).toHaveLength(1);
  await t.close();
  const restarted = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => restarted.close());
  const client = await restarted.client();
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  const after = restarted.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created");
  expect(after).toHaveLength(2);
  expect(after[0]?.streamId).toBe(before[0]?.streamId);
});


it("deduplicates an already continued harness Session, preserves its edits, and retains that mapping after purge", async () => {
  const f = fixture();
  const boundary = fakeAdapter({ script: () => [{ type: "session.provider-linked", payload: { providerSessionId: f.secondaryOnly } }, end()] });
  Object.assign(f.adapter, { createRun: boundary.createRun.bind(boundary) });
  const t = await startTestEnvironment({ ...f.options, accounts: [{ id: "work", provider: "claude", directory: f.winner }] });
  onCleanup(() => t.close());
  const client = await t.client();
  const made = await create(client, { account: "work", title: "Harness title" });
  expect(made.receipt.status).toBe("accepted");
  const started = await client.request("runs.start", { commandId: randomUUID(), sessionId: made.id, text: "Continue elsewhere" });
  expect(started.receipt.status).toBe("accepted");
  await expect.poll(() => t.env.log.readStream({ kind: "session", id: made.id }).some((event) => event.type === "run.ended"), { timeout: WAIT_MS }).toBe(true);
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(t.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created")).toHaveLength(2);
  expect((await client.request("sessions.get", { sessionId: made.id })).summary.title).toBe("Harness title");
  await rename(client, made.id, "Edited harness title");
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect((await client.request("sessions.get", { sessionId: made.id })).summary.title).toBe("Edited harness title");
  await deleteSession(client, made.id);
  expect((await purgeSession(client, made.id)).receipt.status).toBe("accepted");
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(t.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created")).toHaveLength(1);
});

const sharedFixture = (count: number) => {
  const f = fixture();
  const directories = [f.winner, f.secondary, ...(count === 3 ? [tempDir()] : [])];
  for (const [index, directory] of directories.entries()) {
    writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: `account-${index}@example.com` } }));
    if (index > 0) {
      rmSync(join(directory, "projects"), { recursive: true, force: true });
      symlinkSync(join(f.winner, "projects"), join(directory, "projects"), "dir");
    }
  }
  const memory = join(f.winner, "projects", "unmapped", "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "Shared memory\n");
  writeFileSync(join(f.source, "profiles.json"), JSON.stringify({ version: 2, profiles: directories.map((directory, index) => ({ id: `profile-${index}`, label: `Profile ${index}`, providerId: "claude", configDir: directory, publicEnv: {} })) }));
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ archivedSessions: directories.map((_, index) => `profile-${index}:${f.shared}`), pinnedSessions: [`profile-${count - 1}:${f.shared}`] }));
  return { ...f, directories, memory };
};

it.each([2, 3])("offers shared sessions and memory once across %i accounts and imports one archived row", async (count) => {
  const f = sharedFixture(count);
  const transcript = join(f.winner, "projects", "fixture-project", `${f.shared}.jsonl`);
  const bytes = readFileSync(transcript, "utf8");
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  const preview = await client.request("carryOver.inventory", { source: "state-import" });
  if (!("accounts" in preview)) throw new Error("Expected listed-source inventories.");
  expect(preview.accounts.map((entry) => entry.inventory?.sessions.total)).toEqual([1, ...Array<number>(count - 1).fill(0)]);
  expect(preview.accounts.flatMap((entry) => entry.inventory?.memory.unmappable ?? [])).toHaveLength(1);
  const dry = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(dry.result?.carried.archived).toBe(1);
  const applied = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(applied.result?.failed).toEqual([]);
  expect(applied.result?.carried.archived).toBe(1);
  expect(applied.result?.carried.pins).toBe(1);
  const rows = await client.request("sessions.list", {});
  expect(rows.sessions).toHaveLength(1);
  expect(rows.sessions[0]?.archivedAt).not.toBeNull();
  expect(rows.sessions[0]?.pinnedAt).not.toBeNull();
  const adopted = (await client.request("accounts.list", {})).accounts;
  expect(adopted).toHaveLength(count);
  const inventories = await Promise.all(adopted.map((account) => client.request("carryOver.inventory", { accountId: account.id })));
  expect(inventories.flatMap((inventory) => "accountId" in inventory ? inventory.memory.unmappable : [])).toHaveLength(1);
  expect(preview.accounts[1]?.sharedProjectsWith).toBe("profile-0");
  expect(dry.result?.sharedProjects).toHaveLength(count - 1);
  expect(applied.result?.sharedProjects).toEqual(dry.result?.sharedProjects);
  expect(readFileSync(transcript, "utf8")).toBe(bytes);
  expect(readFileSync(join(f.memory, "MEMORY.md"), "utf8")).toBe("Shared memory\n");
});

it("names the profiles sharing a projects folder by their labels in the dry run and the import report (#1726)", async () => {
  const f = sharedFixture(2);
  const [personal, work] = [randomUUID(), randomUUID()].sort();
  writeFileSync(join(f.source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: personal, label: "Personal", providerId: "claude", configDir: f.directories[0], publicEnv: {} },
    { id: work, label: "Work", providerId: "claude", configDir: f.directories[1], publicEnv: {} },
  ] }));
  writeFileSync(join(f.source, "prefs.json"), "{}");
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  const dry = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(dry.result?.sharedProjects).toEqual([{ sourceId: work, label: "Work", ownerSourceId: personal, ownerLabel: "Personal" }]);
  const applied = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(applied.result?.sharedProjects).toEqual(dry.result?.sharedProjects);
});

it("repairs existing triplicates on re-import, retaining pin and archive state across restart and purge", async () => {
  const f = sharedFixture(3);
  writeFileSync(join(f.source, "prefs.json"), "{}");
  const originalProjects = join(f.winner, "projects");
  for (const directory of f.directories.slice(1)) {
    rmSync(join(directory, "projects"));
    cpSync(originalProjects, join(directory, "projects"), { recursive: true });
  }
  const dataDir = tempDir();
  const t = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  const before = (await client.request("sessions.list", {})).sessions;
  expect(before).toHaveLength(3);
  const ownerAccount = (await client.request("accounts.list", {})).accounts.find((account) => account.directory.path === f.winner)!;
  const ownerId = t.env.log.readStream({ kinds: ["session"] }).find((event) => event.type === "session.created" && (event.payload as SessionCreatedPayload).origin?.accountId === ownerAccount.id)!.streamId;
  const duplicates = before.filter((session) => session.id !== ownerId);
  await client.request("sessions.pin", { commandId: randomUUID(), sessionId: duplicates[0]!.id });
  await client.request("sessions.archive", { commandId: randomUUID(), sessionId: duplicates[1]!.id });
  for (const directory of f.directories.slice(1)) {
    rmSync(join(directory, "projects"), { recursive: true });
    symlinkSync(originalProjects, join(directory, "projects"), "dir");
  }
  const repair = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(repair.result?.failed).toEqual([]);
  const after = (await client.request("sessions.list", {})).sessions;
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(ownerId);
  expect(after[0]?.pinnedAt).not.toBeNull();
  expect(after[0]?.archivedAt).not.toBeNull();
  await t.close();
  const restarted = await startTestEnvironment({ ...f.options, dataDir });
  onCleanup(() => restarted.close());
  const second = await restarted.client();
  await second.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect((await second.request("sessions.list", {})).sessions).toHaveLength(1);
  await deleteSession(second, after[0]!.id);
  await purgeSession(second, after[0]!.id);
  await second.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect((await second.request("sessions.list", {})).sessions).toHaveLength(0);
});

it("deduplicates links to a transcript even when the projects directories are distinct", async () => {
  const f = sharedFixture(2);
  const secondaryProjects = join(f.secondary, "projects");
  rmSync(secondaryProjects);
  mkdirSync(join(secondaryProjects, "fixture-project"), { recursive: true });
  symlinkSync(join(f.winner, "projects", "fixture-project", `${f.shared}.jsonl`), join(secondaryProjects, "fixture-project", `${f.shared}.jsonl`), "file");
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  const preview = await client.request("carryOver.inventory", { source: "state-import" });
  if (!("accounts" in preview)) throw new Error("Expected listed-source inventories.");
  expect(preview.accounts.map((entry) => entry.inventory?.sessions.total)).toEqual([1, 0]);
  expect(preview.accounts[1]?.sharedProjectsWith).toBeUndefined();
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  expect((await client.request("sessions.list", {})).sessions).toHaveLength(1);
});

it("previews a deleted shared alias before a live row as one target and keeps the live row when repairing", async () => {
  const f = sharedFixture(2);
  writeFileSync(join(f.source, "prefs.json"), "{}");
  rmSync(join(f.secondary, "projects"));
  cpSync(join(f.winner, "projects"), join(f.secondary, "projects"), { recursive: true });
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  const owner = (await client.request("accounts.list", {})).accounts.find((account) => account.directory.path === f.winner)!;
  const ownerSession = t.env.log.readStream({ kinds: ["session"] }).find((event) => event.type === "session.created" && (event.payload as SessionCreatedPayload).origin?.accountId === owner.id)!.streamId;
  await deleteSession(client, ownerSession);
  const liveSession = (await client.request("sessions.list", {})).sessions[0]!.id;
  rmSync(join(f.secondary, "projects"), { recursive: true });
  symlinkSync(join(f.winner, "projects"), join(f.secondary, "projects"), "dir");
  writeFileSync(join(f.source, "prefs.json"), JSON.stringify({ pinnedSessions: [`profile-0:${f.shared}`] }));
  const dry = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(dry.result?.carried.pins).toBe(1);
  expect(dry.result?.notCarried).not.toContainEqual(expect.objectContaining({ label: "Ambiguous Session references" }));
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  const rows = (await client.request("sessions.list", {})).sessions;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(liveSession);
  expect(rows[0]?.pinnedAt).not.toBeNull();
  const inventory = await client.request("carryOver.inventory", { accountId: owner.id });
  if (!("accountId" in inventory)) throw new Error("Expected an Account inventory.");
  expect(inventory.sessions.new).toBe(0);
  const carried = await client.request("carryOver.run", { commandId: randomUUID(), accountId: owner.id, dryRun: false, skills: true });
  expect(carried.result?.sessions).toMatchObject({ imported: 0, held: 1 });
  expect((await client.request("sessions.list", {})).sessions.map((session) => session.id)).toEqual([liveSession]);
});

it("retains a live shared row when a deleted duplicate has continued history", async () => {
  const f = sharedFixture(2);
  writeFileSync(join(f.source, "prefs.json"), "{}");
  rmSync(join(f.secondary, "projects"));
  cpSync(join(f.winner, "projects"), join(f.secondary, "projects"), { recursive: true });
  const boundary = fakeAdapter({ script: () => [{ type: "session.provider-linked", payload: { providerSessionId: f.shared } }, end()] });
  Object.assign(f.adapter, { createRun: boundary.createRun.bind(boundary) });
  const t = await startTestEnvironment(f.options);
  onCleanup(() => t.close());
  const store = createProviderTranscriptStore({ log: t.env.log, clock: manualClock() });
  const seeded = createClaudeAdapter({ sessionStore: store });
  Object.assign(f.adapter, { seedSessionStore: seeded.seedSessionStore?.bind(seeded) });
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  const owner = (await client.request("accounts.list", {})).accounts.find((account) => account.directory.path === f.winner)!;
  const continuedId = t.env.log.readStream({ kinds: ["session"] }).find((event) => event.type === "session.created" && (event.payload as SessionCreatedPayload).origin?.accountId === owner.id)!.streamId;
  await client.request("accounts.refresh", {});
  expect((await client.request("runs.start", { commandId: randomUUID(), sessionId: continuedId, text: "Continue once" })).receipt.status).toBe("accepted");
  await expect.poll(() => t.env.log.readStream({ kind: "session", id: continuedId }).some((event) => event.type === "run.ended"), { timeout: WAIT_MS }).toBe(true);
  await deleteSession(client, continuedId);
  const liveId = (await client.request("sessions.list", {})).sessions[0]!.id;
  rmSync(join(f.secondary, "projects"), { recursive: true });
  symlinkSync(join(f.winner, "projects"), join(f.secondary, "projects"), "dir");
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.failed).toEqual([]);
  const rows = (await client.request("sessions.list", {})).sessions;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(liveId);
  // The deleted continuation still has its normal restore grace period.
  expect((await client.request("sessions.restore", { commandId: randomUUID(), sessionId: continuedId })).receipt.status).toBe("accepted");
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect((await client.request("sessions.list", {})).sessions.map((session) => session.id)).toEqual([continuedId]);
});
