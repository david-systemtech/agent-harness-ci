import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testCertificates } from "../../test/fake-openbao.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { TOKEN, DAVID, added } from "../../test/forge.js";
import { machinePointedAt } from "./source/folders.js";

/** Fixture stores and git checkouts through typed wire; credentials are deliberately fake. */
const { tempDir, onCleanup } = useCleanups();
const store = (folder: string, name: string, value: unknown) => writeFileSync(join(folder, name), JSON.stringify(value), { mode: 0o600 });
const bank = (slug: string, remote: string) => {
  const path = join(tempDir(), slug);
  mkdirSync(path);
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "--allow-empty", "-m", "Fixture Bank."]);
  return { slug, path, role: "readwrite", enabled: true, profiles: { kind: "all" } };
};
const start = async (folder: string, options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment({ stateImportSource: machinePointedAt({ dataFolder: folder, home: tempDir() }), ...options });
  onCleanup(() => t.close());
  // Set up's start pass appends its results after the start returns: done before the test reads the log or a step (#1804).
  await t.env.setup.startPass;
  return { t, client: await t.client() };
};
const run = async (client: Awaited<ReturnType<typeof start>>["client"], dryRun = false, commandId = randomUUID()) =>
  registry["stateImport.run"].response.parse(await client.request("stateImport.run", { commandId, dryRun }));

describe("state import's Forge credentials and Key-manager records", () => {
  it("groups canonical origins, discards competing Bank names, and never carries tokens or writes in preview", async () => {
    const folder = tempDir();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("alpha", "git@github.com:team/alpha.git"), bank("beta", "https://GITHUB.COM:443/team/beta.git")] });
    store(folder, "memory-bank-tokens.json", { alpha: { username: "git", token: "encrypted-for-tests" }, beta: { kind: "token", username: "git", token: "plaintext-for-tests" } });
    store(folder, "paired-browsers.json", { policy: { devSites: ["dev.example"], evaluateEverywhere: true }, browsers: [{ secret: "browser-secret-for-tests" }] });
    const forgeFetch = vi.fn();
    const { t, client } = await start(folder, { forgeFetch });
    const head = t.env.log.head();
    const preview = (await run(client, true)).result;
    expect(preview?.carried).toMatchObject({ forgeAccounts: 1, devSites: 1 });
    expect(preview?.reEnter.filter((repair) => repair.step !== "memory-bank")).toEqual([{ label: "Forge https://github.com", step: "forges" }]);
    expect(preview?.notCarried).toContainEqual({ label: 'Competing Forge credential from Bank "beta"', count: 1, step: null });
    expect(preview?.notCarried).toContainEqual({ label: "Browser Pairings", count: 1, step: "browser" });
    expect(t.env.log.head()).toBe(head);
    expect((await client.request("settings.get", { keys: ["browser.devSites", "browser.evaluateEverywhere"] })).values).toEqual({ "browser.devSites": [], "browser.evaluateEverywhere": false });
    expect(forgeFetch).not.toHaveBeenCalled();
    const applied = (await run(client)).result;
    expect(applied).toEqual({ ...preview, dryRun: false });
    expect((await client.request("settings.get", { keys: ["browser.devSites", "browser.evaluateEverywhere"] })).values).toEqual({ "browser.devSites": ["dev.example"], "browser.evaluateEverywhere": true });
    expect((await client.request("forge.accounts.list", {})).accounts).toMatchObject([{ origin: "https://github.com", credential: { kind: "none" }, problem: { kind: "needs-credential" } }]);
    expect(JSON.stringify({ applied, events: t.env.log.readStream({ kinds: ["environment", "state-import"] }) })).not.toMatch(/encrypted-for-tests|plaintext-for-tests|browser-secret-for-tests/);
    expect(forgeFetch).not.toHaveBeenCalled();
  });
  it("preserves a winning reference and the connection settings unsigned-in without storing credentials while Bank verification remains unsigned-in", async () => {
    const folder = tempDir();
    const id = randomUUID();
    const ca = testCertificates().ca;
    const ref = { provider: "openbao", connectionId: id, mount: "secret", path: "team/forge", key: "token" };
    store(folder, "memory-banks.json", { version: 2, banks: [bank("encrypted", "https://github.com/team/a"), bank("referenced", "git@github.com:team/b")] });
    store(folder, "memory-bank-tokens.json", { encrypted: { username: "git", token: "encrypted-for-tests" }, referenced: { kind: "ref", username: "git", ref } });
    store(folder, "secret-managers.json", { connections: [{ id, label: "Team keys", provider: "openbao", address: "https://bao.example.test:8200", authMethod: "userpass", caPem: ca, username: "fixture-user", password: "password-for-tests" }], verifications: {} });
    const resolve = vi.fn(async () => ({ outcome: "unavailable" as const, code: "credential_source_unavailable" as const, message: "Sign-in is required for tests." }));
    const forgeFetch = vi.fn();
    const vault = { get: vi.fn(async () => undefined), set: vi.fn(async () => {}), delete: vi.fn(async () => {}), keys: vi.fn(async () => []) };
    const { t, client } = await start(folder, { forgeFetch, keyManagers: { resolve }, vault });
    vault.get.mockClear();
    vault.set.mockClear();
    const preview = (await run(client, true)).result;
    expect(preview?.carried).toMatchObject({ forgeAccounts: 1, keyManagerConnections: 1 });
    expect(preview?.reEnter.filter((repair) => repair.step !== "memory-bank")).toEqual([{ label: 'Key manager "Team keys"', step: "key-manager" }]);
    expect(preview?.notCarried).toContainEqual({ label: 'Competing Forge credential from Bank "encrypted"', count: 1, step: null });
    expect((await client.request("keyManagers.list", {})).connections).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    const applied = (await run(client)).result;
    expect(applied).toEqual({ ...preview, dryRun: false });
    expect((await client.request("keyManagers.list", {})).connections).toMatchObject([{ id, label: "Team keys", address: "https://bao.example.test:8200", method: "userpass", ca, username: "fixture-user", status: { kind: "awaiting-sign-in" }, injects: false }]);
    expect((await client.request("forge.accounts.list", {})).accounts).toMatchObject([{ credential: { kind: "reference", reference: ref } }]);
    expect(resolve).toHaveBeenCalled();
    expect(vault.set).not.toHaveBeenCalled();
    expect(vault.get).not.toHaveBeenCalled();
    expect(forgeFetch).not.toHaveBeenCalled();
    expect(JSON.stringify({ applied, events: t.env.log.readStream({ kinds: ["environment", "state-import"] }) })).not.toMatch(/encrypted-for-tests|password-for-tests/);
  });

  it("rechecks occupied connection ids at commit and fails dependent references without modifying or retargeting them", async () => {
    const folder = tempDir();
    const id = randomUUID();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", "https://github.com/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { kind: "ref", username: "git", ref: { provider: "openbao", connectionId: id, mount: "secret", path: "team/forge", key: "token" } } });
    store(folder, "secret-managers.json", { connections: [{ id, label: "Source keys", provider: "openbao", address: "https://source.example.test", authMethod: "token" }] });
    let occupy = async () => {};
    const { client } = await start(folder, { stateImportHooks: { planned: () => occupy() } });
    occupy = async () => {
      await client.request("keyManagers.connections.add", { commandId: randomUUID(), connectionId: id, provider: "openbao", label: "Harness keys", address: "https://other.example.test", method: "token" });
    };
    expect((await run(client, true)).result?.carried).toMatchObject({ forgeAccounts: 1, keyManagerConnections: 1 });
    const applied = (await run(client)).result;
    expect(applied?.carried).toMatchObject({ forgeAccounts: 0, keyManagerConnections: 0 });
    expect(applied?.failed).toHaveLength(2);
    expect((await client.request("keyManagers.list", {})).connections).toMatchObject([{ id, label: "Harness keys", address: "https://other.example.test" }]);
    expect((await client.request("forge.accounts.list", {})).accounts).toEqual([]);
  });

  it("keeps repair links on re-run and projection rebuild without duplicating or restoring deleted targets", async () => {
    const folder = tempDir();
    const id = randomUUID();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", "https://github.com/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { kind: "ref", username: "git", ref: { provider: "openbao", connectionId: id, mount: "secret", path: "team/forge", key: "token" } } });
    store(folder, "secret-managers.json", { connections: [{ id, label: "Team keys", provider: "openbao", address: "https://bao.example.test", authMethod: "token" }] });
    const { t, client } = await start(folder);
    await run(client);
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    const next = (await run(client)).result;
    expect(next?.carried).toMatchObject({ forgeAccounts: 0, keyManagerConnections: 0 });
    expect(next?.reEnter.filter((repair) => repair.step !== "memory-bank")).toEqual([{ label: 'Key manager "Team keys"', step: "key-manager" }]);
    const account = (await client.request("forge.accounts.list", {})).accounts[0];
    expect(account).toBeDefined();
    await client.request("forge.accounts.remove", { commandId: randomUUID(), forgeAccountId: account?.id ?? "" });
    await run(client);
    expect((await client.request("forge.accounts.list", {})).accounts).toEqual([]);
    expect(t.env.log.readStream({ kinds: ["environment"] }).filter((event) => event.type === "key-manager.connection.added")).toHaveLength(1);
  });

  it("reuses a Forge alias only after the owning service has verified the same identity, and preserves the harness credential", async () => {
    const canonical = await startFakeForge();
    const alias = await startFakeForge();
    onCleanup(() => canonical.close());
    onCleanup(() => alias.close());
    canonical.detectable("forgejo", "1.0.0");
    alias.detectable("forgejo", "1.0.0");
    for (const forge of [canonical, alias]) { forge.user(TOKEN, DAVID); forge.repositories(TOKEN, []); }
    const folder = tempDir();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", alias.origin + "/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { username: "git", token: "encrypted-for-tests" } });
    const { client } = await start(folder);
    const account = await added(client, { url: canonical.origin, kind: "forgejo", aliases: [alias.origin] });
    expect(account.aliases[0]?.verifiedAt).not.toBeNull();
    const imported = (await run(client)).result;
    expect(imported?.carried.forgeAccounts).toBe(0);
    expect(imported?.reEnter.filter((repair) => repair.step !== "memory-bank")).toEqual([]);
    expect((await client.request("forge.accounts.list", {})).accounts).toMatchObject([{ id: account.id, credential: account.credential, aliases: account.aliases }]);
    expect((await run(client)).result?.carried.forgeAccounts).toBe(0);
  });

  it("refuses a changed checkout origin after planning while carrying an independent connection", async () => {
    const folder = tempDir();
    const checkout = bank("team", "https://github.com/team/a");
    store(folder, "memory-banks.json", { version: 2, banks: [checkout] });
    store(folder, "memory-bank-tokens.json", { team: { username: "git", token: "encrypted-for-tests" } });
    store(folder, "secret-managers.json", { connections: [{ id: randomUUID(), label: "Team keys", provider: "openbao", address: "https://bao.example.test", authMethod: "token" }] });
    const { client } = await start(folder, { stateImportHooks: { planned: () => { execFileSync("git", ["-C", checkout.path, "remote", "set-url", "origin", "https://different.example.test/team/a"]); } } });
    const applied = (await run(client)).result;
    expect(applied?.carried).toMatchObject({ forgeAccounts: 0, keyManagerConnections: 1 });
    expect(applied?.failed).toContainEqual({ label: "Bank credentials", message: "It changed after it was read: preview again, then import." });
    expect(applied?.reEnter.filter((repair) => repair.step !== "memory-bank")).toEqual([{ label: 'Key manager "Team keys"', step: "key-manager" }]);
    expect((await client.request("forge.accounts.list", {})).accounts).toEqual([]);
  });

  it("keeps a missing connection reference as a Key-manager repair, separate from import failure", async () => {
    const folder = tempDir();
    const id = randomUUID();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", "https://github.com/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { kind: "ref", username: "git", ref: { provider: "openbao", connectionId: id, mount: "secret", path: "team/forge", key: "token" } } });
    const { client } = await start(folder);
    const applied = (await run(client)).result;
    expect(applied?.failed).toEqual([]);
    expect(applied?.reEnter.filter((repair) => repair.step !== "memory-bank")).toEqual([{ label: `Key manager ${id}`, step: "key-manager" }]);
    const carryOver = (await client.request("setup.check", { step: "carry-over" })).results[0];
    expect(carryOver?.failing).not.toContain("carry-over.last-import");
    const keys = (await client.request("setup.check", { step: "key-manager" })).results[0];
    expect(keys).toMatchObject({ state: "needs-attention", failing: ["key-manager.signed-in"] });
    const forges = (await client.request("setup.check", { step: "forges" })).results[0];
    expect(forges?.failing).toContain("forges.identity");
  });

  it("reports orphaned credentials by Bank name and retries a malformed store independently", async () => {
    const folder = tempDir();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", "https://github.com/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { username: "git", token: "encrypted-for-tests" }, gone: { username: "git", token: "discarded-for-tests" } });
    writeFileSync(join(folder, "secret-managers.json"), "{ password-for-tests");
    const { client } = await start(folder);
    const applied = (await run(client)).result;
    expect(applied?.carried).toMatchObject({ forgeAccounts: 1, keyManagerConnections: 0 });
    expect(applied?.failed).toContainEqual({ label: 'Bank "gone" Forge', message: "Its credential has no declared Bank; no credential was copied." });
    expect(applied?.failed).toContainEqual({ label: "Key-manager connections", message: "The Key-manager registry is not JSON." });
    expect(JSON.stringify(applied)).not.toMatch(/password-for-tests|discarded-for-tests|encrypted-for-tests/);
    store(folder, "secret-managers.json", { connections: [{ id: randomUUID(), label: "Fixed keys", provider: "doppler", address: "https://api.doppler.com", authMethod: "token", token: "password-for-tests" }] });
    const retried = (await run(client)).result;
    expect(retried?.carried).toMatchObject({ forgeAccounts: 0, keyManagerConnections: 1 });
    expect(retried?.failed).toEqual([{ label: 'Bank "gone" Forge', message: "Its credential has no declared Bank; no credential was copied." }]);
  });

  it("refuses an unverified alias held by the Forge owner in both preview and application", async () => {
    const canonical = await startFakeForge();
    const alias = await startFakeForge();
    onCleanup(() => canonical.close());
    onCleanup(() => alias.close());
    alias.detectable("forgejo", "1.0.0");
    const folder = tempDir();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", alias.origin + "/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { username: "git", token: "encrypted-for-tests" } });
    const { client } = await start(folder);
    const account = await added(client, { url: canonical.origin, kind: "forgejo", credential: { kind: "none" }, aliases: [alias.origin] });
    expect(account.aliases).toEqual([{ origin: alias.origin, verifiedAt: null }]);
    const preview = (await run(client, true)).result;
    expect(preview?.carried.forgeAccounts).toBe(0);
    expect(preview?.failed).toEqual([{ label: `Forge ${alias.origin}`, message: "The Forge owner has not verified this alias as the same identity." }]);
    expect((await run(client)).result).toEqual({ ...preview, dryRun: false });
    expect((await client.request("forge.accounts.list", {})).accounts).toMatchObject([{ id: account.id, aliases: account.aliases }]);
  });

  it("resumes after a committed connection across restart and retries the same command from its receipt without new events", async () => {
    const folder = tempDir();
    const dataDir = tempDir();
    const id = randomUUID();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", "https://github.com/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { kind: "ref", username: "git", ref: { provider: "openbao", connectionId: id, mount: "secret", path: "team/forge", key: "token" } } });
    store(folder, "secret-managers.json", { connections: [{ id, label: "Team keys", provider: "openbao", address: "https://bao.example.test", authMethod: "token" }] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => logged.mockRestore());
    const { t, client } = await start(folder, { dataDir, stateImportHooks: { carried: ({ kind }) => { if (kind === "key-manager-connection") throw new Error("Stopped between items."); } } });
    const commandId = randomUUID();
    await expect(run(client, false, commandId)).rejects.toMatchObject({ code: "internal" });
    expect((await client.request("keyManagers.list", {})).connections).toHaveLength(1);
    expect((await client.request("forge.accounts.list", {})).accounts).toEqual([]);
    await t.close();
    const restarted = await start(folder, { dataDir });
    const resumed = await run(restarted.client, false, commandId);
    expect(resumed.result?.carried).toMatchObject({ forgeAccounts: 1, keyManagerConnections: 0 });
    expect(resumed.result?.failed).toEqual([]);
    const head = restarted.t.env.log.head();
    expect(await run(restarted.client, false, commandId)).toEqual({ receipt: resumed.receipt });
    expect(restarted.t.env.log.head()).toBe(head);
    expect((await run(restarted.client)).result?.carried).toMatchObject({ forgeAccounts: 0, keyManagerConnections: 0 });
    expect((await restarted.client.request("keyManagers.list", {})).connections).toHaveLength(1);
    expect((await restarted.client.request("forge.accounts.list", {})).accounts).toHaveLength(1);
    expect(restarted.t.env.log.readStream({ kinds: ["state-import"] }).filter((event) => event.type === "state-import.item-carried").map((event) => event.payload["kind"])).toEqual(["key-manager-connection", "forge-account", "bank-default", "bank"]);
    logged.mockRestore();
  });

  it("refuses a preserved reference whose occupied id belongs to a different provider", async () => {
    const folder = tempDir();
    const id = randomUUID();
    store(folder, "memory-banks.json", { version: 2, banks: [bank("team", "https://github.com/team/a")] });
    store(folder, "memory-bank-tokens.json", { team: { kind: "ref", username: "git", ref: { provider: "openbao", connectionId: id, mount: "secret", path: "team/forge", key: "token" } } });
    const { client } = await start(folder);
    await client.request("keyManagers.connections.add", { commandId: randomUUID(), connectionId: id, provider: "doppler", label: "Other keys", address: "https://api.doppler.com" });
    const preview = (await run(client, true)).result;
    expect(preview?.carried.forgeAccounts).toBe(0);
    expect(preview?.failed).toHaveLength(1);
    expect((await run(client)).result).toEqual({ ...preview, dryRun: false });
    expect((await client.request("forge.accounts.list", {})).accounts).toEqual([]);
    expect((await client.request("keyManagers.list", {})).connections).toMatchObject([{ id, provider: "doppler", label: "Other keys" }]);
  });

});
