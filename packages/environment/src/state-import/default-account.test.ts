import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { machinePointedAt } from "./source/folders.js";

const { tempDir, onCleanup } = useCleanups();

it("reports a signed-out default as Re-enter, links Accounts, and follows sign-in without importing again", async () => {
  const source = tempDir();
  const directory = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  writeFileSync(join(source, "prefs.json"), JSON.stringify({ activeProfileId: "work" }));
  let signedIn = false;
  const adapter = { ...fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: () => signedInAs(signedIn ? "work@example.com" : null) }), observeIdentity: async () => ({ provider: "claude", email: "work@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [], stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const repair = { label: "Sign in Work, then the default follows", step: "account" };
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ result: { failed: [], reEnter: [repair] } });
  expect(await client.request("accounts.list", {})).toEqual({ accounts: [] });
  expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { accounts: 1 }, failed: [], reEnter: [repair] } });
  const { accounts } = await client.request("accounts.list", {});
  const id = accounts[0]!.id;
  expect(await client.request("setup.check", { step: "carry-over" })).toMatchObject({ results: [{ state: "needs-attention", reason: "Your default account waits for Work to sign in. Choose Sign in Work.", targets: [{ action: "sign-in-again", kind: "account", id, label: "Work" }] }] });
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": null } });
  signedIn = true;
  await client.request("accounts.refresh", { accountId: id });
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": id } });
  // The state import finished: the line says when, not that the data folder is still there to bring over (#1698).
  expect(await client.request("setup.check", { step: "carry-over" })).toMatchObject({ results: [{ state: "done", reason: `Brought over ${t.clock.now().toISOString().slice(0, 10)} ${t.clock.now().toISOString().slice(11, 16)} UTC.` }] });
  await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultAccount": null } });
  await client.request("accounts.refresh", { accountId: id });
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(await client.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": null } });
});

it("keeps a later-provider default in Re-enter with an Accounts link instead of a failed import", async () => {
  const source = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "later", label: "Later work", providerId: "codex", configDir: "/fixture/not-read" }] }));
  writeFileSync(join(source, "prefs.json"), JSON.stringify({ activeProfileId: "later" }));
  const t = await startTestEnvironment({ adapter: fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [] }), accounts: [], stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
  onCleanup(() => t.close());
  const client = await t.client();
  for (const dryRun of [true, false]) {
    expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun })).toMatchObject({ result: { failed: [], reEnter: [{ label: "Sign in Later work, then the default follows", step: "account" }], later: [{ provider: "codex" }] } });
  }
  expect(await client.request("setup.check", { step: "carry-over" })).toMatchObject({ results: [{ state: "needs-attention", actions: ["sign-in-again"], targets: [{ action: "sign-in-again", kind: "environment", id: expect.any(String), label: "Accounts" }] }] });
});

it.each([false, true])("retains a deferred default across restart and respects a later default edit (%s)", async (edit) => {
  const source = tempDir();
  const directory = tempDir();
  const existing = tempDir();
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  writeFileSync(join(source, "prefs.json"), JSON.stringify({ activeProfileId: "work" }));
  let signedIn = false;
  const adapter = { ...fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: (account) => signedInAs(account.directory === existing ? "other@example.com" : signedIn ? "work@example.com" : null) }), observeIdentity: async () => ({ provider: "claude", email: "work@example.com", organisation: null }) };
  const options = { adapter, dataDir: tempDir(), accounts: [{ id: "other", provider: "claude", directory: existing }], stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) };
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  const client = await t.client();
  await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  const id = (await client.request("accounts.list", {})).accounts.find((account) => account.label === "Work")!.id;
  if (edit) {
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultAccount": "other" } });
    expect(await client.request("setup.check", { step: "carry-over" })).toMatchObject({ results: [{ state: "done" }] });
    expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { reEnter: [], failed: [] } });
  }
  // Changes to the source's preference after import do not replace the retained choice.
  writeFileSync(join(source, "prefs.json"), JSON.stringify({ activeProfileId: "missing" }));
  await t.close();
  signedIn = true;
  const restarted = await startTestEnvironment(options);
  onCleanup(() => restarted.close());
  const reader = await restarted.client();
  expect(await reader.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": edit ? "other" : id } });
  expect(await reader.request("setup.check", { step: "carry-over" })).toMatchObject({ results: [{ state: "done" }] });
  await reader.request("environment.rebuildProjections", { commandId: randomUUID() });
  await reader.request("accounts.refresh", { accountId: id });
  expect(await reader.request("settings.get", { keys: ["accounts.defaultAccount"] })).toEqual({ values: { "accounts.defaultAccount": edit ? "other" : id } });
});
