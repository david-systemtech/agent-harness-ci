import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { snapshotOf } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";
import { createAccountService } from "../accounts/account-service.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { createAdapterRegistry } from "../adapter/registry.js";
import { createTrash } from "../serve/trash.js";
import { skillsCarryOver } from "../skills/carry-over.js";
import { createOwnDirectory, prepareOwnDirectory } from "../skills/own-directory.js";
import { createAutoMemory } from "../workspace/auto-memory.js";
import { directoryInventory } from "./directory-inventory.js";

const { tempDir, onCleanup } = useCleanups();

it("plans sessions, memory and skills from an explicit directory before an Account exists, without changing source or target", async () => {
  const directory = tempDir();
  const workspace = tempDir();
  const write = (path: string, text: string) => writeFileSync(join(directory, path), text);
  mkdirSync(join(directory, "projects", "fixture", "memory"), { recursive: true });
  write("projects/fixture/session.jsonl", JSON.stringify({ type: "user", cwd: workspace }) + "\n");
  write("projects/fixture/memory/MEMORY.md", "Remember the fixture.\n");
  mkdirSync(join(directory, "skills", "check"), { recursive: true });
  write("skills/check/SKILL.md", "---\nname: check\ndescription: Check the fixture.\n---\nCheck it.\n");
  mkdirSync(join(directory, "commands"));
  write("commands/review.md", "---\ndescription: Review it.\n---\nReview the fixture.\n");
  write(".credentials.json", "credential-for-tests");
  const tracked = join(directory, "skills", "tracked");
  mkdirSync(tracked);
  write("skills/tracked/SKILL.md", "---\nname: tracked\ndescription: Keep as a source.\n---\nTracked skill.\n");
  git(tracked, "init", "-q");
  git(tracked, "add", ".");
  git(tracked, "commit", "-q", "-m", "fixture");
  git(tracked, "remote", "add", "origin", "https://example.com/fixture/skills.git");
  const adapter = fakeAdapter({
    ambientDirectory: null,
    sessions: (account) => {
      expect(account.directory).toBe(directory);
      return [{ providerSessionId: "fixture-session", customTitle: "Fixture", summary: null, firstPrompt: "Read it", workingDirectory: workspace, tag: "archived", createdAt: null, lastModified: "2026-10-01T00:00:00.000Z" }];
    },
  });
  const t = await startTestEnvironment({ adapter, accounts: [], setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const trash = createTrash({ dataDir: t.dataDir, clock: t.clock });
  const skills = skillsCarryOver({
    own: createOwnDirectory({ path: prepareOwnDirectory(t.dataDir), log: t.env.log, environmentId: t.env.id, trash }),
    environmentId: t.env.id, account: () => null, home: tempDir(),
  });
  const inventory = directoryInventory({
    log: t.env.log, adapters: createAdapterRegistry([adapter]), looks: { look: async () => "present", identityAt: async () => null },
    autoMemory: createAutoMemory(join(t.dataDir, "auto-memory")), skills, home: tempDir(),
  });
  const client = await t.client();
  const source = snapshotOf(directory);
  const target = snapshotOf(t.dataDir);
  const events = t.env.log.readStream({ kinds: ["environment", "account", "session"] });
  const reads = adapter.statusReads.length;

  const planned = await inventory({ provider: "fake", account: { id: "planned-account", directory } });
  expect(planned).toMatchObject({
    accountId: "planned-account", sessions: { total: 1, archived: 1, missingDirectory: 0, new: 1 },
    memory: { folders: 1, repositories: 1, unmappable: [], new: 1 }, skills: { skills: 2, commands: 1, new: 2, offered: [{ name: "tracked", from: tracked, url: "https://example.com/fixture/skills.git" }], invalid: 0 },
  });
  expect(await client.request("accounts.list", {})).toEqual({ accounts: [] });
  expect(adapter.statusReads).toHaveLength(reads);
  expect(snapshotOf(directory)).toEqual(source);
  expect(snapshotOf(t.dataDir)).toEqual(target);
  expect(t.env.log.readStream({ kinds: ["environment", "account", "session"] })).toEqual(events);

  const service = createAccountService({
    log: t.env.log, clock: t.clock, environmentId: t.env.id, ownedRoot: null,
    adapters: [{ ...adapter, observeIdentity: async () => ({ provider: "fake", email: "person@example.com", organisation: null }) }],
  });
  onCleanup(() => service.close());
  const observed = await service.observeDirectory({ provider: "fake", directory });
  t.env.methods.register<"accounts.adopt">(registry["accounts.adopt"], (_params, context) => service.adoptDirectory({ source: observed }, context));
  const adoption = await client.request("accounts.adopt", { commandId: randomUUID() });
  const accountId = adoption.result!.account.id;
  expect(await client.request("carryOver.inventory", { accountId })).toEqual({ ...planned, accountId });
  const dry = await client.request("carryOver.run", { commandId: randomUUID(), accountId, dryRun: true, skills: true });
  expect(dry.result).toMatchObject({ sessions: { listed: 1, imported: 1, archived: 1 }, skills: { copied: [{ name: "check" }, { name: "review" }], offered: [{ name: "tracked" }] }, failed: [] });
  const imported = await client.request("carryOver.run", { commandId: randomUUID(), accountId, dryRun: false, skills: true });
  expect(imported.result).toEqual({ ...dry.result, dryRun: false, skills: { ...dry.result!.skills, dryRun: false } });
  expect(await client.request("carryOver.inventory", { accountId })).toMatchObject({ sessions: { total: 1, new: 0 }, memory: { new: 0 }, skills: { new: 0, offered: [{ name: "tracked" }] } });
  expect(snapshotOf(directory)).toEqual(source);
});
