import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { PERSONAL_BANK, changed } from "../../../contracts/test/fixture-banks.js";
import { snapshotOf } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";
import { machinePointedAt } from "./source/folders.js";

const { tempDir, onCleanup } = useCleanups();
const store = (folder: string, name: string, value: unknown) => writeFileSync(join(folder, name), JSON.stringify(value));
const bank = (name: string, files = PERSONAL_BANK) => {
  const path = join(tempDir(), name);
  mkdirSync(path);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), text);
  }
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "add", "--all");
  git(path, "commit", "--quiet", "-m", "Fixture Bank.");
  return { slug: name, path, role: "readwrite", enabled: true, profiles: { kind: "all" } };
};
const start = async (source: string, options: TestEnvironmentOptions = {}) => {
  const adapter = fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: () => signedInAs("fixture@example.com") });
  const observed = { ...adapter, observeIdentity: async () => ({ provider: "claude", email: "fixture@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter: observed, accounts: [], stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }), ...options });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};
type Client = Awaited<ReturnType<typeof start>>["client"];
const run = (client: Client, dryRun = false) => client.request("stateImport.run", { commandId: randomUUID(), dryRun });

it("previews and registers retained checkouts with mapped Account scopes, attach roles, default and provenance", async () => {
  const source = tempDir();
  const directory = tempDir();
  store(source, "profiles.json", { version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] });
  const writable = { ...bank("personal"), profiles: { kind: "profiles", profileIds: ["work"] } };
  const attached = { ...bank("attach", changed(PERSONAL_BANK, { "BANK.md": null })), role: "readonly" };
  store(source, "memory-banks.json", { version: 2, banks: [writable, attached], default: "personal" });
  writeFileSync(join(writable.path, "BANK.md"), "Uncommitted fixture work must stay untouched.\n");
  writeFileSync(join(attached.path, "untracked-work.txt"), "Retained fixture work.\n");
  const before = [snapshotOf(writable.path), snapshotOf(attached.path)];
  const { t, client } = await start(source);
  const head = t.env.log.head();
  expect(await run(client, true)).toMatchObject({ result: { carried: { accounts: 1, banks: 2 }, failed: [], reEnter: [{ label: 'Bank "attach": BANK.md needs migration or repair', step: "memory-bank" }] } });
  expect(t.env.log.head()).toBe(head);
  expect(await client.request("banks.list", {})).toEqual({ banks: [] });
  expect(await run(client)).toMatchObject({ result: { carried: { accounts: 1, banks: 2 }, failed: [] } });
  const account = (await client.request("accounts.list", {})).accounts[0]!;
  const { banks } = await client.request("banks.list", {});
  expect(banks).toMatchObject([
    { checkout: writable.path, checkoutOwnership: "registered", accounts: [account.id], role: "read-write", defaultFor: [account.id], importedFrom: expect.any(String), credential: "forge" },
    { checkout: attached.path, accounts: "all", role: "read-only", defaultFor: [], status: { manifest: { state: "missing" } }, importedFrom: expect.any(String) },
  ]);
  expect(banks[0]?.importedFrom).not.toBe(banks[1]?.importedFrom);
  expect([snapshotOf(writable.path), snapshotOf(attached.path)]).toEqual(before);
  expect((await client.request("setup.check", {})).results.find((result) => result.step === "memory-bank")).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"] });
});

it("refuses unresolved and malformed scopes without widening them, retains earlier success and retries a repaired Bank", async () => {
  const source = tempDir();
  const good = bank("good");
  const unresolved = { ...bank("unresolved", changed(PERSONAL_BANK, { "BANK.md": null })), profiles: { kind: "profiles", profileIds: ["missing"] } };
  const malformed = { ...bank("malformed", changed(PERSONAL_BANK, { "BANK.md": null })), profiles: { kind: "profiles", profileIds: "all" } };
  const entries: (typeof good | typeof unresolved | typeof malformed)[] = [good, unresolved, malformed];
  store(source, "memory-banks.json", { version: 2, banks: entries, default: "good" });
  const { client } = await start(source);
  const preview = (await run(client, true)).result!;
  expect(preview.carried.banks).toBe(1);
  expect(preview.failed.map((item) => item.label)).toEqual(['Bank "unresolved"', 'Bank "malformed"']);
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: preview.failed });
  expect((await client.request("banks.list", {})).banks).toHaveLength(1);
  entries[1] = { ...unresolved, profiles: { kind: "profiles", profileIds: [] } };
  store(source, "memory-banks.json", { version: 2, banks: entries, default: "good" });
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: [{ label: 'Bank "malformed"' }] });
  expect((await client.request("banks.list", {})).banks).toHaveLength(2);
});

it("names the dropped master-memory and follow-ups-as-issues switches and preserves disabled registry entries", async () => {
  const source = tempDir();
  const disabled = { ...bank("disabled", changed(PERSONAL_BANK, { "BANK.md": null })), enabled: false };
  store(source, "memory-banks.json", { version: 2, banks: [disabled] });
  store(source, "cerebro.json", { version: 1, enabled: true, followUpsAsIssues: false });
  const { t, client } = await start(source);
  const head = t.env.log.head();
  const preview = (await run(client, true)).result!;
  expect(preview.notCarried).toEqual([
    { label: "Master memory switch", count: 1, step: null },
    { label: "Follow-ups-as-issues switch", count: 1, step: null },
  ]);
  expect(t.env.log.head()).toBe(head);
  expect((await run(client)).result?.notCarried).toEqual(preview.notCarried);
  expect((await client.request("banks.list", {})).banks).toMatchObject([{ enabled: false, defaultFor: [], status: { manifest: { state: "missing" } } }]);
});

it("keeps harness scope/default edits and deleted Banks after projection rebuild and a changed source default", async () => {
  const source = tempDir();
  const writable = bank("personal");
  const removable = bank("removed", changed(PERSONAL_BANK, { "BANK.md": null }));
  store(source, "memory-banks.json", { version: 2, banks: [writable, removable], default: "personal" });
  const { client } = await start(source, { accounts: [{ id: "work", provider: "claude", directory: tempDir() }] });
  expect((await run(client)).result?.failed).toEqual([]);
  const original = (await client.request("banks.list", {})).banks;
  const first = original[0]!;
  await client.request("banks.registry.update", { commandId: randomUUID(), bankId: first.id, accounts: [], defaultFor: [], role: "read-only" });
  await client.request("banks.forget", { commandId: randomUUID(), bankId: original[1]!.id });
  const addition = bank("addition", changed(PERSONAL_BANK, { "BANK.md": null }));
  store(source, "memory-banks.json", { version: 2, banks: [writable, removable, addition], default: "addition" });
  await client.request("environment.rebuildProjections", { commandId: randomUUID() });
  const expected = (await client.request("banks.list", {})).banks[0];
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: [] });
  expect((await client.request("banks.list", {})).banks).toEqual([expected, expect.objectContaining({ checkout: addition.path, defaultFor: [] })]);
  expect((await run(client)).result?.carried.banks).toBe(0);
});

it("commits Bank events and mappings together, then resumes after a crash between Banks without duplicating them", async () => {
  const source = tempDir();
  const dataDir = tempDir();
  const first = bank("first", changed(PERSONAL_BANK, { "BANK.md": null }));
  const second = bank("second", changed(PERSONAL_BANK, { "BANK.md": null }));
  store(source, "memory-banks.json", { version: 2, banks: [first, second], default: "first" });
  const { t, client } = await start(source, { dataDir, accounts: [{ id: "work", provider: "claude", directory: tempDir() }], stateImportHooks: { carried: ({ kind }) => { if (kind === "bank") throw new Error("Fixture import stopped between Banks."); } } });
  await expect(run(client)).rejects.toMatchObject({ code: "internal" });
  const events = t.env.log.readStream({ kinds: ["environment", "state-import"] });
  const added = events.find((event) => event.type === "bank.added")!;
  const mappings = events.filter((event) => event.type === "state-import.item-carried");
  expect(mappings.map((event) => event.payload["kind"])).toEqual(["bank-default", "bank"]);
  expect(mappings.map((event) => event.commandId)).toEqual([added.commandId, added.commandId]);
  const registered = (await client.request("banks.list", {})).banks[0];
  expect(registered).toMatchObject({ defaultFor: ["work"], status: { manifest: { state: "missing" } } });
  await t.close();
  const resumed = await start(source, { dataDir });
  await resumed.client.request("environment.rebuildProjections", { commandId: randomUUID() });
  expect((await run(resumed.client)).result).toMatchObject({ carried: { banks: 1 }, failed: [] });
  expect((await resumed.client.request("banks.list", {})).banks).toEqual([registered, expect.objectContaining({ checkout: second.path })]);
  expect((await run(resumed.client)).result?.carried.banks).toBe(0);
});

it("reports an unreadable Bank safely, then retries it without losing an earlier registration", async () => {
  const source = tempDir();
  const good = bank("good");
  const repair = { ...bank("repair", changed(PERSONAL_BANK, { "BANK.md": null })), path: join(tempDir(), "missing-token-for-tests") };
  const entries = [good, repair];
  store(source, "memory-banks.json", { version: 2, banks: entries, default: "good" });
  const { client } = await start(source);
  const preview = (await run(client, true)).result!;
  expect(preview).toMatchObject({ carried: { banks: 1 }, failed: [{ label: 'Bank "repair"' }] });
  expect(JSON.stringify(preview)).not.toContain("missing-token-for-tests");
  expect((await run(client)).result).toEqual({ ...preview, dryRun: false });
  entries[1] = bank("repair", changed(PERSONAL_BANK, { "BANK.md": null }));
  store(source, "memory-banks.json", { version: 2, banks: entries, default: "good" });
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: [] });
  expect((await client.request("banks.list", {})).banks).toHaveLength(2);
});

it("keeps owner admission refusals repairable without mapping the failed Bank or replacing the admitted default", async () => {
  const source = tempDir();
  const first = bank("first");
  const collision = bank("collision");
  store(source, "memory-banks.json", { version: 2, banks: [first, collision], default: "first" });
  const { t, client } = await start(source, { accounts: [{ id: "work", provider: "claude", directory: tempDir() }] });
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: [{ label: 'Bank "collision"' }] });
  const admitted = (await client.request("banks.list", {})).banks;
  expect(admitted).toMatchObject([{ defaultFor: ["work"] }]);
  expect(t.env.log.readStream({ kinds: ["state-import"] }).filter((event) => event.type === "state-import.item-carried" && event.payload["sourceId"] === "collision")).toEqual([]);
  const renamed = (PERSONAL_BANK["BANK.md"] ?? "").replace("maya-memory", "collision");
  writeFileSync(join(collision.path, "BANK.md"), renamed);
  git(collision.path, "add", "BANK.md");
  git(collision.path, "commit", "--quiet", "-m", "Repair the fixture Bank name.");
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: [] });
  expect((await client.request("banks.list", {})).banks).toMatchObject([{ id: admitted[0]!.id, defaultFor: ["work"] }, { name: "collision", defaultFor: [] }]);
});

it("refuses a scope whose mapped Account disappears after preview planning", async () => {
  const source = tempDir();
  const directory = tempDir();
  store(source, "profiles.json", { version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] });
  let remove = async () => {};
  const { client } = await start(source, { stateImportHooks: { planned: () => remove() } });
  await run(client);
  const account = (await client.request("accounts.list", {})).accounts[0]!;
  const scoped = { ...bank("scoped"), profiles: { kind: "profiles", profileIds: ["work"] } };
  store(source, "memory-banks.json", { version: 2, banks: [scoped] });
  expect((await run(client, true)).result?.carried.banks).toBe(1);
  remove = async () => { await client.request("accounts.remove", { commandId: randomUUID(), accountId: account.id }); };
  expect((await run(client)).result).toMatchObject({ carried: { banks: 0 }, failed: [{ label: 'Bank "scoped"' }, { label: 'Sessions for Claude profile "Work"' }] });
  expect(await client.request("banks.list", {})).toEqual({ banks: [] });
});

it.each([{ role: "readwrite", enabled: false }, { role: "readonly", enabled: true }])("keeps an unapplied default visible after a source repair ($role, enabled=$enabled)", async ({ role, enabled }) => {
  const source = tempDir();
  const original = { ...bank("pending"), role, enabled };
  store(source, "memory-banks.json", { version: 2, banks: [original], default: "pending" });
  const { t, client } = await start(source, { accounts: [{ id: "work", provider: "claude", directory: tempDir() }] });
  expect((await run(client)).result).toMatchObject({ carried: { banks: 1 }, failed: [{ label: "Default Bank" }] });
  const registered = (await client.request("banks.list", {})).banks;
  expect(registered).toMatchObject([{ role: role === "readonly" ? "read-only" : "read-write", enabled, defaultFor: [] }]);
  store(source, "memory-banks.json", { version: 2, banks: [{ ...original, role: "readwrite", enabled: true }], default: "pending" });
  const head = t.env.log.head();
  const preview = (await run(client, true)).result!;
  expect(preview).toMatchObject({ carried: { banks: 0 }, failed: [{ label: "Default Bank", message: "Its default was not carried when this Bank was registered; choose the default in Memory bank settings. The harness defaults are preserved." }] });
  expect(t.env.log.head()).toBe(head);
  expect((await run(client)).result).toMatchObject({ carried: { banks: 0 }, failed: preview.failed });
  expect((await client.request("banks.list", {})).banks).toEqual(registered);
  expect(t.env.log.readStream({ kinds: ["state-import"] }).filter((event) => event.type === "state-import.item-carried" && event.payload["kind"] === "bank-default")).toEqual([]);
});
