import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { snapshotOf } from "../../test/accounts.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { createClaudeAdapter } from "../adapters/claude/index.js";
import { machinePointedAt } from "./source/folders.js";

const { tempDir, onCleanup } = useCleanups();

it("adopts only listed directories without ambient sign-in or refreshing credentials, and holds fresh and retried imports", async () => {
  const source = tempDir();
  const directory = tempDir();
  const unlisted = tempDir();
  for (const path of [directory, unlisted]) writeFileSync(join(path, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "fixture@example.com" } }));
  writeFileSync(join(directory, ".credentials.json"), "credential-for-tests");
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory, publicEnv: {} }] }));
  const runCommand = vi.fn(() => { throw new Error("Import must not start a provider process."); });
  const t = await startTestEnvironment({ otherAdapters: [createClaudeAdapter({ executablePath: "unused-fixture-binary", runCommand, hostEnv: { HOME: tempDir() } })], accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  runCommand.mockClear(); // Startup owns the ambient status read; import must never repeat it.
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ result: { carried: { accounts: 1 }, failed: [] } });
  expect(await client.request("accounts.list", {})).toEqual({ accounts: [] });
  const commandId = randomUUID();
  expect(await client.request("stateImport.run", { commandId, dryRun: false })).toMatchObject({ result: { carried: { accounts: 1 }, failed: [] } });
  expect(await client.request("accounts.list", {})).toMatchObject({ accounts: [{ label: "Work", directory: { kind: "adopted", path: directory }, identity: { email: "fixture@example.com" } }] });
  expect(runCommand).not.toHaveBeenCalled();
  expect(await client.request("stateImport.run", { commandId, dryRun: false })).toMatchObject({ receipt: { status: "accepted" } });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 0 }, failed: [] } });
});

it("chooses the latest duplicate's directory, maps all source scopes and the active profile, and preserves later default edits", async () => {
  const source = tempDir();
  const older = tempDir();
  const newer = tempDir();
  for (const directory of [older, newer]) writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "shared@example.com" } }));
  const profiles = [
    { id: "older", label: "Older", providerId: "claude", configDir: older, publicEnv: {} },
    { id: "newer", label: "Newest", providerId: "claude", configDir: newer, publicEnv: {} },
  ];
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles }));
  writeFileSync(join(source, "prefs.json"), JSON.stringify({ activeProfileId: "older" }));
  writeFileSync(join(source, "agent-prompts.json"), JSON.stringify({ version: 1, prompts: [{ id: "work", name: "Work", markdown: "Check changes.", enabled: false, scope: { kind: "profiles", profileIds: ["older", "newer"] } }] }));
  const base = createClaudeAdapter({ executablePath: "unused-fixture-binary", hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("No provider process during import."); } });
  const adapter = { ...base, status: async () => signedInAs("shared@example.com"), models: fakeAdapter().models, listSessions: async (account: { directory: string | null }) => [{ providerSessionId: randomUUID(), workingDirectory: tempDir(), summary: "Source use", customTitle: null, firstPrompt: "Hello", tag: null, createdAt: null, lastModified: account.directory === newer ? "2026-09-02T00:00:00.000Z" : "2026-09-01T00:00:00.000Z" }] };
  const t = await startTestEnvironment({ otherAdapters: [adapter], accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ result: { carried: { accounts: 1, instructions: 1 }, failed: [] } });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 1, instructions: 1 }, failed: [] } });
  const { accounts } = await client.request("accounts.list", {});
  expect(accounts).toMatchObject([{ label: "Newest", directory: { path: newer } }]);
  const id = accounts[0]?.id;
  await client.request("accounts.refresh", { accountId: id! });
  expect(await client.request("instructions.list", {})).toMatchObject({ instructions: [{ title: "Work", enabled: false, scope: [id] }] });
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": id } });
  await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultAccount": null } });
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": null } });
});

it("serves per-source inventories before adoption through carryOver.inventory, without arbitrary paths or domain writes", async () => {
  const source = tempDir();
  const directory = tempDir();
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "preview@example.com" } }));
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "preview", label: "Preview", providerId: "claude", configDir: directory, publicEnv: {} }] }));
  const t = await startTestEnvironment({ otherAdapters: [createClaudeAdapter({ executablePath: "unused-fixture-binary", hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("No process."); } })], accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const sessionId = randomUUID();
  const workspace = tempDir();
  mkdirSync(join(directory, "projects", "fixture", "memory"), { recursive: true });
  writeFileSync(join(directory, "projects", "fixture", "memory", "MEMORY.md"), "Fixture memory.\n");
  writeFileSync(join(directory, "projects", "fixture", `${sessionId}.jsonl`), JSON.stringify({ type: "user", sessionId, cwd: workspace, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: "Fixture session" } }) + "\n");
  mkdirSync(join(directory, "skills", "check"), { recursive: true });
  writeFileSync(join(directory, "skills", "check", "SKILL.md"), "---\nname: check\ndescription: Check fixture work.\n---\nCheck changes.\n");
  const before = t.env.log.readStream({ kinds: ["account", "state-import", "environment"] });
  const sourceBefore = snapshotOf(directory);
  // Runtime contract checks must reject unrecognised directory locators.
  await expect(client.request("carryOver.inventory", { source: "state-import" })).resolves.toMatchObject({ accounts: [{ sourceId: "preview", label: "Preview", inventory: { sessions: { total: 1 }, memory: { folders: 1 }, skills: { skills: 1 } }, failure: null }], failed: [], later: [] });
  expect(await client.request("accounts.list", {})).toEqual({ accounts: [] });
  expect(t.env.log.readStream({ kinds: ["account", "state-import", "environment"] })).toEqual(before);
  expect(snapshotOf(directory)).toEqual(sourceBefore);
  await expect(client.request("carryOver.inventory", { directory } as never)).rejects.toMatchObject({ code: "invalid_params" });
});

it("retains a mapped secondary directory as an import source when a fresh report sees an edited profile", async () => {
  const source = tempDir();
  const primary = tempDir();
  const secondary = tempDir();
  const replacement = tempDir();
  const base = createClaudeAdapter({ executablePath: "unused-fixture-binary", hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("No process."); } });
  for (const directory of [primary, secondary]) writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "retained@example.com" } }));
  writeFileSync(join(replacement, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "different@example.com" } }));
  const profiles = [
    { id: "a", label: "Primary", providerId: "claude", configDir: primary, publicEnv: {} },
    { id: "b", label: "Secondary", providerId: "claude", configDir: secondary, publicEnv: {} },
  ];
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles }));
  const workspace = tempDir();
  const adapter = { ...base, listSessions: async (account: { directory: string | null }) => account.directory === replacement ? [] : [{ providerSessionId: "fixture-session", workingDirectory: workspace, summary: "Retained use", customTitle: null, firstPrompt: "Hello", tag: null, createdAt: null, lastModified: "2026-09-01T00:00:00.000Z" }] };
  const t = await startTestEnvironment({ otherAdapters: [adapter], accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [profiles[0], { ...profiles[1], configDir: replacement }] }));
  expect(await client.request("carryOver.inventory", { source: "state-import" })).toMatchObject({ accounts: [{ sourceId: "a", inventory: { sessions: { total: 1 } } }, { sourceId: "b", inventory: { sessions: { total: 1 } } }] });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 0 }, failed: [] } });
});

it("breaks identity ties by source id and rechecks bounded numeric label collisions at commit", async () => {
  const source = tempDir();
  const first = tempDir();
  const second = tempDir();
  const distinct = tempDir();
  const label = "L".repeat(200);
  const profiles = [
    { id: "b", label, providerId: "claude", configDir: second },
    { id: "a", label, providerId: "claude", configDir: first },
    { id: "c", label, providerId: "claude", configDir: distinct },
  ];
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: () => signedInAs("registered@example.com") });
  const adapter = { ...base, observeIdentity: async (directory: string) => ({ provider: "claude", email: directory === distinct ? "distinct@example.com" : "shared@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [{ id: "existing", provider: "claude", directory: tempDir() }], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }), stateImportHooks: { planned: async () => { await client.request("accounts.relabel", { commandId: randomUUID(), accountId: "existing", label }); } } });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 2 }, failed: [] } });
  expect(await client.request("accounts.list", {})).toMatchObject({ accounts: [
    { id: "existing", label },
    { label: "L".repeat(196) + " (2)", directory: { path: first } },
    { label: "L".repeat(196) + " (3)", directory: { path: distinct } },
  ] });
});

it("reuses registered identity and directory Accounts without relabelling them and maps Instructions to their ids", async () => {
  const source = tempDir();
  const registered = tempDir();
  const alias = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: "directory", label: "Source label", providerId: "claude", configDir: registered },
    { id: "identity", label: "Alias label", providerId: "claude", configDir: alias },
  ] }));
  writeFileSync(join(source, "agent-prompts.json"), JSON.stringify({ version: 1, prompts: [{ id: "scope", name: "Scope", markdown: "Keep the mapping.", enabled: true, scope: { kind: "profiles", profileIds: ["directory", "identity"] } }] }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: () => signedInAs("reuse@example.com") });
  const adapter = { ...base, observeIdentity: async () => ({ provider: "claude", email: "REUSE@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [{ id: "kept", provider: "claude", directory: registered }], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ result: { carried: { accounts: 0, instructions: 1 }, failed: [] } });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 0, instructions: 1 }, failed: [] } });
  expect(await client.request("accounts.list", {})).toMatchObject({ accounts: [{ id: "kept", label: "kept", directory: { path: registered } }] });
  expect(await client.request("instructions.list", {})).toMatchObject({ instructions: [{ scope: ["kept"] }] });
});

it("counts a fresh adoption when the registered Account disappears after planning", async () => {
  const source = tempDir();
  const directory = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: () => signedInAs("reuse@example.com") });
  const adapter = { ...base, observeIdentity: async () => ({ provider: "claude", email: "reuse@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [{ id: "existing", provider: "claude", directory }], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }), stateImportHooks: { planned: async () => {
    expect(await client.request("accounts.remove", { commandId: randomUUID(), accountId: "existing" })).toMatchObject({ result: { accountId: "existing", directoryDeleted: false } });
  } } });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 1 }, failed: [] } });
  const { accounts } = await client.request("accounts.list", {});
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ label: "Work", directory: { path: directory } });
  expect(accounts[0]?.id).not.toBe("existing");
});

it("fails unreadable identities, invalid labels, unresolved scopes and defaults independently, then retries repaired profiles with a fresh command", async () => {
  const source = tempDir();
  const good = tempDir();
  const badIdentity = tempDir();
  const badLabel = tempDir();
  const identity = (directory: string, email: string) => writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  identity(good, "good@example.com");
  identity(badLabel, "label@example.com");
  writeFileSync(join(badIdentity, ".claude.json"), "invalid fixture JSON");
  const profiles = [
    { id: "good", label: "Good", providerId: "claude", configDir: good },
    { id: "identity", label: "Identity", providerId: "claude", configDir: badIdentity },
    { id: "label", label: " bad label ", providerId: "claude", configDir: badLabel },
    { id: "deferred", label: "Other provider", providerId: "codex", configDir: "/never-read-this-fixture" },
  ];
  const writeProfiles = () => writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles }));
  writeProfiles();
  writeFileSync(join(source, "prefs.json"), JSON.stringify({ activeProfileId: "identity" }));
  writeFileSync(join(source, "agent-prompts.json"), JSON.stringify({ version: 1, prompts: [
    { id: "mapped", name: "Mapped", markdown: "Mapped text", enabled: false, scope: { kind: "profiles", profileIds: ["good"] } },
    { id: "unresolved", name: "Unresolved", markdown: "Never widen", enabled: true, scope: { kind: "profiles", profileIds: ["good", "missing"] } },
  ] }));
  const base = createClaudeAdapter({ executablePath: "unused-fixture-binary", hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("No process."); } });
  const t = await startTestEnvironment({ otherAdapters: [{ ...base, status: async (account) => signedInAs(account.id === "existing" ? "existing@example.com" : "repaired@example.com"), models: fakeAdapter().models }], accounts: [{ id: "existing", provider: "claude", directory: tempDir() }], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultAccount": "existing" } });
  const commandId = randomUUID();
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result?.failed).toHaveLength(4);
  // A profile is named by its label, or by its directory when its label is not one (#1726).
  expect(preview.result?.failed.map((failure) => failure.label)).toEqual(expect.arrayContaining(['Claude profile "Identity"', `Claude profile in ${badLabel}`]));
  expect(preview.result?.later).toEqual([{ label: "Profile for codex", provider: "codex" }]);
  expect(await client.request("carryOver.inventory", { source: "state-import" })).toMatchObject({ later: [{ label: "Profile for codex", provider: "codex" }] });
  expect(await client.request("stateImport.run", { commandId, dryRun: false })).toMatchObject({ result: { carried: { accounts: 1, instructions: 1 }, failed: preview.result?.failed } });
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": "existing" } });
  identity(badIdentity, "repaired@example.com");
  profiles[2]!.label = "Repaired label";
  writeProfiles();
  expect(await client.request("stateImport.run", { commandId, dryRun: false })).toMatchObject({ receipt: { status: "accepted" } });
  expect((await client.request("accounts.list", {})).accounts).toHaveLength(2);
  const repaired = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(repaired.result?.carried.accounts).toBe(2);
  expect(repaired.result?.failed).toHaveLength(1);
  await client.request("accounts.refresh", {});
  const { accounts } = await client.request("accounts.list", {});
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": accounts.find((entry) => entry.label === "Identity")?.id } });
  expect((await client.request("instructions.list", {})).instructions).toHaveLength(1);
});

it("keeps Account mappings across restart after an item commits and preserves removed mapped Accounts", async () => {
  const source = tempDir();
  const first = tempDir();
  const second = tempDir();
  const profiles = [
    { id: "a", label: "First", providerId: "claude", configDir: first },
    { id: "b", label: "Second", providerId: "claude", configDir: second },
  ];
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles }));
  const adapter = { ...fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: (account) => signedInAs(account.directory === first ? "first@example.com" : "second@example.com") }), observeIdentity: async (directory: string) => ({ provider: "claude", email: directory === first ? "first@example.com" : "second@example.com", organisation: null }) };
  const machine = machinePointedAt({ dataFolder: source, home: tempDir() });
  const t = await startTestEnvironment({ adapter, dataDir: tempDir(), accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machine, stateImportHooks: { carried: () => { throw new Error("Fixture crash after the first item commit."); } } });
  onCleanup(() => t.close());
  await expect((await t.client()).request("stateImport.run", { commandId: randomUUID(), dryRun: false })).rejects.toMatchObject({ code: "internal" });
  await t.close();
  const restarted = await startTestEnvironment({ adapter, dataDir: t.dataDir, accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machine });
  onCleanup(() => restarted.close());
  const client = await restarted.client();
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 1 }, failed: [] } });
  const { accounts } = await client.request("accounts.list", {});
  expect(accounts.map((entry) => entry.label)).toEqual(["First", "Second"]);
  await client.request("accounts.remove", { commandId: randomUUID(), accountId: accounts[0]!.id });
  await client.request("environment.rebuildProjections", { commandId: randomUUID() });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 0 }, failed: [] } });
  expect((await client.request("accounts.list", {})).accounts.map((entry) => entry.label)).toEqual(["Second"]);
});

it("refuses changed profile bytes before adoption and fails dependent scopes without widening them", async () => {
  const source = tempDir();
  const directory = tempDir();
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "changed@example.com" } }));
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  writeFileSync(join(source, "agent-prompts.json"), JSON.stringify({ version: 1, prompts: [{ id: "scoped", name: "Scoped", markdown: "Keep scope", enabled: true, scope: { kind: "profiles", profileIds: ["work"] } }] }));
  const t = await startTestEnvironment({ otherAdapters: [createClaudeAdapter({ executablePath: "unused-fixture-binary", hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("No process."); } })], accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }), stateImportHooks: { planned: () => { writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [] })); } } });
  onCleanup(() => t.close());
  const client = await t.client();
  const answer = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(answer.result?.failed).toHaveLength(2);
  expect(answer.result?.failed).toMatchObject([{ label: "Accounts" }, { label: 'Instruction "Scoped"' }]);
  expect(await client.request("accounts.list", {})).toEqual({ accounts: [] });
  expect((await client.request("instructions.list", {})).instructions).toEqual([]);
});
