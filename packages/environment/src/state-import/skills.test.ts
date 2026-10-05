import { CarryOverInventory } from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, TOKEN } from "../../test/forge.js";
import { snapshotOf } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { skill, skillRepositories, skillsInsteadOf, testGit } from "../../test/skill-repositories.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { machinePointedAt } from "./source/folders.js";

const { tempDir, onCleanup } = useCleanups();

it("imports tracked sources through Skills with the checkout's branch and detached pin retained", async () => {
  const source = tempDir();
  const forge = skillRepositories(tempDir);
  const branch = forge.commit("team/branch", { "skills/check/SKILL.md": skill("check") }, "work");
  const pin = forge.commit("team/pin", { "SKILL.md": skill("write") });
  const clones = join(source, "skill-sources");
  mkdirSync(clones);
  testGit(clones, "clone", "--quiet", "--branch", "work", join(forge.root, "team/branch.git"), "skills-test-team-branch-461078a2");
  testGit(join(clones, "skills-test-team-branch-461078a2"), "branch", "--move", "work-local");
  testGit(clones, "clone", "--quiet", join(forge.root, "team/pin.git"), "skills-test-team-pin-020dfcc1");
  testGit(join(clones, "skills-test-team-pin-020dfcc1"), "checkout", "--quiet", "--detach", pin);
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, sources: [
    { id: "untrusted", url: "https://skills.test/team/branch", subdir: "skills" },
    { url: "https://skills.test/team/pin", subdir: "." },
  ], alwaysOn: [] }));
  const t = await startTestEnvironment({ adapter: fakeAdapter(), setupSteps: NO_SETUP_STEPS, harnessGitConfig: skillsInsteadOf(forge), stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const bytes = snapshotOf(source);
  const skillRoot = join(t.dataDir, "skills");
  const targets = existsSync(skillRoot) ? snapshotOf(skillRoot) : [];
  const events = t.env.log.readStream({ kinds: ["skills", "state-import", "environment"] });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ result: { carried: { skillSources: 2 }, failed: [] } });
  expect(snapshotOf(source)).toEqual(bytes);
  expect(existsSync(skillRoot) ? snapshotOf(skillRoot) : []).toEqual(targets);
  expect(t.env.log.readStream({ kinds: ["skills", "state-import", "environment"] })).toEqual(events);
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { skillSources: 2 }, failed: [] } });
  expect(await client.request("skills.get", {})).toMatchObject({ sources: [
    { url: "https://skills.test/team/branch", folder: "skills", follow: { kind: "branch", branch: "work" }, commit: branch },
    { url: "https://skills.test/team/pin", folder: ".", follow: { kind: "pinned", commit: pin }, commit: pin },
  ] });
});

it("applies exact known names only to mapped Accounts and reports unknown and deferred choices", async () => {
  const source = tempDir();
  const work = tempDir();
  const personal = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: "work", label: "Work", providerId: "claude", configDir: work },
    { id: "personal", label: "Personal", providerId: "claude", configDir: personal },
    { id: "later", label: "Later", providerId: "codex", configDir: tempDir() },
  ] }));
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, alwaysOn: [
    { name: "check", scope: { kind: "profiles", profileIds: ["work"] } },
    { name: "write", scope: { kind: "all" } },
    { name: "check-more", scope: { kind: "profiles", profileIds: ["personal"] } },
    { name: "missing", scope: { kind: "profiles", profileIds: ["later", "unlisted"] } },
  ] }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [] });
  const adapter = { ...base, observeIdentity: async (directory: string) => ({ provider: "claude", email: directory === work ? "work@example.com" : "personal@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  for (const name of ["check", "write"]) await client.request("skills.own.create", { commandId: randomUUID(), name, description: "A fixture Skill." });
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview).toMatchObject({ result: { carried: { accounts: 2, alwaysOnSkills: 3 }, failed: expect.arrayContaining([
    { label: expect.stringContaining("check-more"), message: expect.stringContaining("unknown") },
    { label: expect.stringContaining("later"), message: expect.stringContaining("mapped Account") },
    { label: expect.stringContaining("unlisted"), message: expect.stringContaining("mapped Account") },
  ]) } });
  const answer = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(answer).toMatchObject({ result: { carried: { accounts: 2, alwaysOnSkills: 3 }, failed: expect.any(Array) } });
  const { accounts } = await client.request("accounts.list", {});
  const workId = accounts.find((account) => account.label === "Work")?.id;
  const personalId = accounts.find((account) => account.label === "Personal")?.id;
  expect((await client.request("skills.get", {})).choices).toEqual([
    { kind: "always-on", name: "check", accountId: workId, on: true },
    ...[workId, personalId].sort().map((accountId) => ({ kind: "always-on", name: "write", accountId, on: true })),
  ]);
});

it("keeps earlier successes, retries repaired sources and names, and preserves edited and deleted imports across restart", async () => {
  const source = tempDir();
  const directory = tempDir();
  const forge = skillRepositories(tempDir);
  const pin = forge.commit("team/pin", { "SKILL.md": skill("write") });
  forge.commit("team/broken", { "README.md": "No Skill yet.\n" });
  const document = { version: 1, sources: [
    { url: "https://skills.test/team/pin", subdir: "." },
    { url: "https://skills.test/team/broken", subdir: "skills" },
    { url: "https://bad:token-for-tests@skills.test/team/secret", subdir: "." },
  ], alwaysOn: [{ name: "write", scope: { kind: "all" } }, { name: "repair", scope: { kind: "all" } }] };
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  writeFileSync(join(source, "skills.json"), JSON.stringify(document));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [] });
  const adapter = { ...base, observeIdentity: async () => ({ provider: "claude", email: "work@example.com", organisation: null }) };
  const options = { dataDir: tempDir(), adapter, accounts: [], setupSteps: NO_SETUP_STEPS, harnessGitConfig: skillsInsteadOf(forge), stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) };
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  const client = await t.client();
  const first = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(first).toMatchObject({ result: { carried: { skillSources: 1, alwaysOnSkills: 1 }, failed: expect.arrayContaining([
    { label: expect.stringContaining("broken"), message: expect.stringContaining("no valid skill") },
    { label: expect.stringContaining("repair"), message: expect.stringContaining("unknown") },
  ]) } });
  expect(JSON.stringify(first)).not.toContain("token-for-tests");
  const view = await client.request("skills.get", {});
  const sourceId = view.sources[0]!.id;
  const accountId = (await client.request("accounts.list", {})).accounts[0]!.id;
  await client.request("skills.sources.setFollow", { commandId: randomUUID(), sourceId, follow: { kind: "pinned", commit: pin } });
  await client.request("skills.setAlwaysOn", { commandId: randomUUID(), accountId, name: "write", on: false });
  forge.commit("team/broken", { "skills/repair/SKILL.md": skill("repair") });
  writeFileSync(join(source, "skills.json"), JSON.stringify({ ...document, sources: document.sources.slice(0, 2).reverse() }));
  const retry = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(retry).toMatchObject({ result: { carried: { skillSources: 1, alwaysOnSkills: 1 }, failed: [] } });
  expect(await client.request("skills.get", {})).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: sourceId, follow: { kind: "pinned", commit: pin } })]), choices: expect.arrayContaining([{ kind: "always-on", name: "write", accountId, on: false }, { kind: "always-on", name: "repair", accountId, on: true }]) });
  await client.request("skills.sources.remove", { commandId: randomUUID(), sourceId });
  await t.close();
  const restarted = await startTestEnvironment({ ...options, dataDir: t.dataDir });
  onCleanup(() => restarted.close());
  const again = await restarted.client();
  expect(await again.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { skillSources: 0, alwaysOnSkills: 0 }, failed: [] } });
  expect((await again.request("skills.get", {})).sources).toHaveLength(1);
});

it("previews unresolved names and remote sources without git, sync, copies or target writes", async () => {
  const source = tempDir();
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, sources: [{ url: "https://skills.test/team/remote", subdir: "skills" }], alwaysOn: [{ name: "check", scope: { kind: "profiles", profileIds: ["missing"] } }, { name: "write", scope: {} }] }));
  const git = vi.fn(async () => { throw new Error("Preview must never fetch."); });
  const t = await startTestEnvironment({ adapter: fakeAdapter(), setupSteps: NO_SETUP_STEPS, skillsGit: git, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const bytes = snapshotOf(source);
  const events = t.env.log.readStream({ kinds: ["skills", "state-import", "environment"] });
  const view = await client.request("skills.get", {});
  const own = snapshotOf(view.ownDirectory);
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ result: { carried: { skillSources: 1, alwaysOnSkills: 0 }, failed: [
    { label: 'Always-on Skill "check" (missing)', message: expect.stringContaining("mapped Account") },
    { label: 'Always-on Skill "write"', message: expect.stringContaining("unreadable") },
  ] } });
  expect(git).not.toHaveBeenCalled();
  expect(snapshotOf(source)).toEqual(bytes);
  expect(snapshotOf(view.ownDirectory)).toEqual(own);
  expect(await client.request("skills.get", {})).toEqual(view);
  expect(t.env.log.readStream({ kinds: ["skills", "state-import", "environment"] })).toEqual(events);
});

it("retains durable source child receipts when an import stops before its final report", async () => {
  const source = tempDir();
  const forge = skillRepositories(tempDir);
  for (const path of ["team/pin", "team/branch"]) forge.commit(path, { "SKILL.md": skill(path.split("/")[1]!) });
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, sources: [
    { url: "https://skills.test/team/pin", subdir: "." },
    { url: "https://skills.test/team/branch", subdir: "." },
  ], alwaysOn: [] }));
  const options = { dataDir: tempDir(), adapter: fakeAdapter(), setupSteps: NO_SETUP_STEPS, harnessGitConfig: skillsInsteadOf(forge), stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) };
  const t = await startTestEnvironment({ ...options, stateImportHooks: { carried: () => { throw new Error("Fixture interruption after child commit."); } } });
  onCleanup(() => t.close());
  const client = await t.client();
  await expect(client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).rejects.toMatchObject({ code: "internal" });
  const held = (await client.request("skills.get", {})).sources[0]!.id;
  await t.close();
  const restarted = await startTestEnvironment({ ...options, dataDir: t.dataDir });
  onCleanup(() => restarted.close());
  const again = await restarted.client();
  expect(await again.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { skillSources: 1 }, failed: [] } });
  const sources = (await again.request("skills.get", {})).sources;
  expect(sources).toHaveLength(2);
  expect(sources[0]!.id).toBe(held);
});

it("reuses an existing natural source and Account choice, retains disable rules, and retries a failed mapped scope", async () => {
  const source = tempDir();
  const directory = tempDir();
  const forge = skillRepositories(tempDir);
  const pin = forge.commit("team/pin", { "SKILL.md": skill("write") });
  const profiles = [
    { id: "b", label: "Alias", providerId: "claude", configDir: directory },
    { id: "a", label: "Work", providerId: "claude", configDir: directory },
  ];
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles }));
  const document = { version: 1, sources: [{ url: "https://skills.test/team/pin.git", subdir: "." }], alwaysOn: [{ name: "write", scope: { kind: "profiles", profileIds: ["b", "a"] } }] };
  writeFileSync(join(source, "skills.json"), JSON.stringify(document));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [] });
  const adapter = { ...base, observeIdentity: async () => ({ provider: "claude", email: "work@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [], setupSteps: NO_SETUP_STEPS, harnessGitConfig: skillsInsteadOf(forge), stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const added = await client.request("skills.sources.add", { commandId: randomUUID(), url: "https://skills.test/team/pin", folder: ".", follow: { kind: "pinned", commit: pin } });
  const sourceId = added.result!.source.id;
  // Give Account adoption its own import, leaving the Skill scope for a later retry.
  writeFileSync(join(source, "skills.json"), JSON.stringify({ ...document, alwaysOn: [{ name: "write", scope: { kind: "profiles", profileIds: ["missing"] } }] }));
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 1, skillSources: 0, alwaysOnSkills: 0 }, failed: [{ label: expect.stringContaining("missing") }] } });
  const accountId = (await client.request("accounts.list", {})).accounts[0]!.id;
  await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "write", accountId, on: false });
  await client.request("skills.setEnabled", { commandId: randomUUID(), name: "write", accountId: null, enabled: false });
  writeFileSync(join(source, "skills.json"), JSON.stringify(document));
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { skillSources: 0, alwaysOnSkills: 0 }, failed: [] } });
  expect(await client.request("skills.get", {})).toMatchObject({ sources: [{ id: sourceId, follow: { kind: "pinned", commit: pin } }], choices: [
    { kind: "enabled", name: "write", accountId: null, enabled: false },
    { kind: "always-on", name: "write", accountId, on: false },
  ], members: [{ name: "write", enabled: false }] });
  // A held name remains held even after the person's off choice and the source scope are edited.
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: profiles.reverse() }));
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { alwaysOnSkills: 0 }, failed: [] } });
});

it("identifies each mapped Account when an always-on name is unknown or invalid", async () => {
  const source = tempDir();
  const work = tempDir();
  const personal = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: "work", label: "Work", providerId: "claude", configDir: work },
    { id: "personal", label: "Personal", providerId: "claude", configDir: personal },
  ] }));
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, alwaysOn: [
    { name: "missing", scope: { kind: "all" } },
    { name: "Invalid!", scope: { kind: "all" } },
  ] }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [] });
  const adapter = { ...base, observeIdentity: async (directory: string) => ({ provider: "claude", email: directory === work ? "work@example.com" : "personal@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  for (const dryRun of [true, false]) {
    const answer = await client.request("stateImport.run", { commandId: randomUUID(), dryRun });
    expect(answer.result?.failed).toEqual([
      { label: 'Always-on Skill "Invalid!" (personal)', message: expect.stringContaining("validation") },
      { label: 'Always-on Skill "Invalid!" (work)', message: expect.stringContaining("validation") },
      { label: 'Always-on Skill "missing" (personal)', message: expect.stringContaining("unknown") },
      { label: 'Always-on Skill "missing" (work)', message: expect.stringContaining("unknown") },
    ]);
    expect(answer.result?.carried.alwaysOnSkills).toBe(0);
  }
  expect((await client.request("skills.get", {})).choices).toEqual([]);
});

it.each(["sources", "alwaysOn"])("reports malformed %s fields without blocking Account adoption and retries after repair", async (field) => {
  const source = tempDir();
  const directory = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [
    { id: "work", label: "Work", providerId: "claude", configDir: directory },
  ] }));
  const path = join(source, "skills.json");
  writeFileSync(path, JSON.stringify({ version: 1, [field]: {} }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [] });
  const adapter = { ...base, observeIdentity: async () => ({ provider: "claude", email: "work@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const bytes = snapshotOf(source);
  for (const dryRun of [true, false]) {
    expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun })).toMatchObject({ result: {
      carried: { accounts: 1, skillSources: 0, alwaysOnSkills: 0 },
      failed: [{ label: "Skills", message: expect.stringContaining(field) }],
    } });
  }
  expect(snapshotOf(source)).toEqual(bytes);
  const accountId = (await client.request("accounts.list", {})).accounts[0]!.id;
  await client.request("skills.own.create", { commandId: randomUUID(), name: "check", description: "A fixture Skill." });
  writeFileSync(path, JSON.stringify({ version: 1, sources: [], alwaysOn: [{ name: "check", scope: { kind: "profiles", profileIds: ["work"] } }] }));
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: {
    carried: { accounts: 0, skillSources: 0, alwaysOnSkills: 1 }, failed: [],
  } });
  expect((await client.request("skills.get", {})).choices).toEqual([{ kind: "always-on", name: "check", accountId, on: true }]);
});


it("keeps signed-in accounts and sessions while naming the forge and skill repairs a partial import needs", async () => {
  const source = tempDir();
  const directory = tempDir();
  const workspace = tempDir();
  const forge = skillRepositories(tempDir);
  forge.commit("team/private", { "SKILL.md": skill("missing") });
  let authenticated = false;
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1,
    sources: [{ url: "https://skills.test/team/private", subdir: "." }],
    alwaysOn: [{ name: "missing", scope: { kind: "all" } }],
  }));
  const base = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [{
    providerSessionId: "held-session", customTitle: "Carried session", summary: null, firstPrompt: null,
    workingDirectory: workspace, tag: null, createdAt: "2026-09-01T00:00:00.000Z", lastModified: "2026-09-01T00:00:00.000Z",
  }] });
  const adapter = { ...base, observeIdentity: async () => ({ provider: "claude", email: "work@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [],
    harnessGitConfig: skillsInsteadOf(forge),
    skillsGit: async (request, git) => authenticated ? git(request) : { outcome: "ran", git: {
      ok: false, code: 128, stdout: Buffer.alloc(0), stderr: "fatal: Authentication failed", truncated: false, timedOut: false, missing: false,
    } },
    stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }),
  });
  onCleanup(() => t.close());
  const client = await t.client();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => logged.mockRestore());
  const run = (dryRun: boolean) => client.request("stateImport.run", { commandId: randomUUID(), dryRun });
  const sourceBytes = snapshotOf(source);
  const first = await run(false);
  expect(first).toMatchObject({ result: { carried: { accounts: 1 }, reEnter: expect.arrayContaining([
    { label: expect.stringContaining("https://skills.test"), step: "forges" },
    { label: expect.stringContaining("missing"), step: "skills" },
  ]) } });
  const accounts = (await client.request("accounts.refresh", {})).accounts;
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.status.state).toBe("signed-in");
  const accountId = accounts[0]!.id;
  const added = await client.request("accounts.add", { commandId: randomUUID(), provider: "claude", label: "New connection" });
  const ownedId = added.result!.account.id;
  expect((await client.request("accounts.refresh", {})).accounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: ownedId, directory: expect.objectContaining({ kind: "owned" }), status: expect.objectContaining({ state: "signed-in" }) }),
  ]));
  const accountIds = [accountId, ownedId].sort();
  const before = CarryOverInventory.parse(await client.request("carryOver.inventory", { accountId }));
  expect(before.sessions).toMatchObject({ total: 1, new: 0 });
  const failedCheck = (await client.request("setup.check", { step: "carry-over" })).results[0];
  expect(failedCheck).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });
  await run(true);
  expect((await client.request("setup.check", { step: "carry-over" })).results[0]?.state).toBe("needs-attention");
  expect(await run(false)).toMatchObject({ result: { carried: { accounts: 0 }, failed: expect.arrayContaining([
    { label: expect.stringContaining("private"), message: expect.stringContaining("credential") },
  ]) } });
  expect((await client.request("accounts.list", {})).accounts.map((account) => account.id).sort()).toEqual(accountIds);
  expect(CarryOverInventory.parse(await client.request("carryOver.inventory", { accountId })).sessions).toEqual(before.sessions);
  expect((await client.request("carryOver.run", { commandId: randomUUID(), accountId, dryRun: false, skills: true })).result?.sessions).toMatchObject({ imported: 0, held: 1 });
  authenticated = true;
  expect(await run(false)).toMatchObject({ result: { carried: { accounts: 0, skillSources: 1, alwaysOnSkills: 1 }, failed: [], reEnter: [] } });
  expect((await client.request("setup.check", { step: "carry-over" })).results[0]?.state).toBe("done");
  expect((await client.request("accounts.list", {})).accounts.map((account) => account.id).sort()).toEqual(accountIds);
  expect(CarryOverInventory.parse(await client.request("carryOver.inventory", { accountId })).sessions).toEqual(before.sessions);
  expect(snapshotOf(source)).toEqual(sourceBytes);
});


it("names the serving forge account's canonical origin for SSH and verified alias authentication failures", async () => {
  const forge = await startFakeForge();
  const alias = await startFakeForge();
  onCleanup(() => forge.close());
  onCleanup(() => alias.close());
  for (const instance of [forge, alias]) {
    instance.user(TOKEN, { login: "fixture", id: 42 });
    instance.repositories(TOKEN, []);
  }
  const canonical = "https://forge.skills.test:5526";
  const verifiedAlias = "https://alias.skills.test";
  const source = tempDir();
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, sources: [
    { url: "git@forge.skills.test:team/private.git", subdir: "." },
    { url: `${verifiedAlias}/team/other`, subdir: "." },
  ], alwaysOn: [] }));
  const t = await startTestEnvironment({ adapter: fakeAdapter(), setupSteps: NO_SETUP_STEPS,
    forgeFetch: (url, init) => fetch(String(url).replace(canonical, forge.origin).replace(verifiedAlias, alias.origin), init),
    skillsGit: async () => ({ outcome: "ran", git: { ok: false, code: 128, stdout: Buffer.alloc(0), stderr: "fatal: Authentication failed", truncated: false, timedOut: false, missing: false } }),
    stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }),
  });
  onCleanup(() => t.close());
  const client = await t.client();
  const account = await added(client, { url: canonical, kind: "forgejo", aliases: [verifiedAlias] });
  expect(account.aliases).toEqual([{ origin: verifiedAlias, verifiedAt: expect.any(String) }]);
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => logged.mockRestore());
  const imported = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(imported.result?.failed).toEqual([
    { label: expect.any(String), message: expect.stringContaining("Authentication failed") },
    { label: expect.any(String), message: expect.stringContaining("Authentication failed") },
  ]);
  expect(imported.result?.reEnter).toEqual([{ label: `Forge credential for ${canonical}, then import again`, step: "forges" }]);
});


it.each([
  ["git@ssh.skills.test:team/private.git", "Permission denied (publickey).", "ssh.skills.test"],
  ["ssh://git@ssh.skills.test:2222/team/private.git", "Host key verification failed.", "ssh.skills.test"],
  ["ssh://git@ssh.github.com:443/team/private.git", "Host key verification failed.", "ssh.github.com"],
])("keeps machine SSH repair guidance for an unmanaged source %s", async (url, stderr, host) => {
  const source = tempDir();
  writeFileSync(join(source, "skills.json"), JSON.stringify({ version: 1, sources: [{ url, subdir: "." }], alwaysOn: [] }));
  const t = await startTestEnvironment({ adapter: fakeAdapter(), setupSteps: NO_SETUP_STEPS,
    skillsGit: async () => ({ outcome: "ran", git: { ok: false, code: 128, stdout: Buffer.alloc(0), stderr, truncated: false, timedOut: false, missing: false } }),
    stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }),
  });
  onCleanup(() => t.close());
  const client = await t.client();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => logged.mockRestore());
  const imported = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(imported.result?.failed).toEqual([{ label: expect.any(String), message: expect.stringContaining(`SSH keys and known-hosts entry for ${host}, using the source's SSH port`) }]);
  expect(imported.result?.reEnter).toEqual([]);
});
