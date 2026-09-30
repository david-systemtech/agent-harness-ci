import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { scriptedKeychain, type KeychainCall, type ScriptedKeychain } from "../../test/keychain.js";
import { createScrubRegistry } from "../scrub/registry.js";
import { chooseVault, KEYCHAIN_INDEX_FILE, loadKeychainBinding, type VaultChoice } from "./keychain.js";
import { fileVault, holdVault, VAULT_FILE } from "./vault.js";

const { tempDir } = useCleanups();
const posix = process.platform !== "win32";

const ENVIRONMENT_ID = "0b7d3a2e-5c1f-4e8a-9d6b-2f4c8e1a7b3d";
/** The keychain service a new environment's entries go under. */
const SERVICE = `agent-harness ${ENVIRONMENT_ID}`;
const SIGNING = "signing-value-for-tests";
const FORGE = "forge-token-for-tests";

/**
 * An environment's data directory and a scripted keychain, and the chooser
 * over them: preset on macOS under the launch agent, so the vault is the
 * keychain unless the test says otherwise. Each `choose` is a start.
 */
const machine = (keychain: ScriptedKeychain = scriptedKeychain()) => {
  const dataDir = tempDir();
  const file = join(dataDir, VAULT_FILE);
  const choose = (overrides: Partial<VaultChoice> = {}) =>
    chooseVault({ platform: "darwin", asService: true, dataDir, environmentId: ENVIRONMENT_ID, loadBinding: keychain.load, ...overrides });
  return { dataDir, file, keychain, choose };
};

/** Whether the file vault at `path` holds `key`, read straight from the file. */
const fileHolds = (path: string, key: string): boolean => existsSync(path) && Object.hasOwn(JSON.parse(readFileSync(path, "utf8")) as object, key);

describe("the vault chooser", () => {
  it("keeps the vault in the file on Linux, without loading the keychain's binding", async () => {
    const { file, keychain, choose } = machine();
    const chosen = await choose({ platform: "linux" });
    await chosen.vault.set("signing", SIGNING);
    expect(await fileVault(file).get("signing")).toBe(SIGNING);
    expect(keychain.loads()).toBe(0);
    expect(chosen.reason).toBe(`The vault is the file ${file}: the OS keychain is the vault on macOS and Windows only, and this machine runs linux.`);
  });

  it.each([
    ["darwin", "launch agent"],
    ["win32", "logon task"],
  ] as const)("keeps the vault in the file on %s when no launcher started the environment, as under the %s", async (platform, runner) => {
    const { file, keychain, choose } = machine();
    const chosen = await choose({ platform, asService: false });
    await chosen.vault.set("signing", SIGNING);
    expect(await fileVault(file).get("signing")).toBe(SIGNING);
    expect(keychain.loads()).toBe(0);
    expect(chosen.reason).toBe(`The vault is the file ${file}: the OS keychain is the vault only where the environment runs as the user's ${runner}, and no launcher started this one.`);
  });

  it.each(["darwin", "win32"] as const)("makes the OS keychain the vault on %s under the service, the entries under the environment's own service", async (platform) => {
    const { file, keychain, choose } = machine();
    const chosen = await choose({ platform });
    await chosen.vault.set("signing", SIGNING);
    expect(keychain.entry(SERVICE, "signing")).toBe(SIGNING);
    expect(await chosen.vault.get("signing")).toBe(SIGNING);
    expect(existsSync(file)).toBe(false);
    expect(chosen.reason).toBe(`The vault is the OS keychain, service "${SERVICE}": the file ${file} held nothing to move into it.`);
  });

  it("keeps the vault in the file when the keychain's binding is not installed", async () => {
    const { file, keychain, choose } = machine(scriptedKeychain({ load: "not-installed" }));
    const chosen = await choose();
    await chosen.vault.set("signing", SIGNING);
    expect(await fileVault(file).get("signing")).toBe(SIGNING);
    expect(keychain.loads()).toBe(1);
    expect(chosen.reason).toBe(`The vault is the file ${file}: the OS keychain's binding, @napi-rs/keyring, is not installed.`);
  });

  it("keeps the vault in the file when the keychain's binding does not load, saying why", async () => {
    const { file, choose } = machine(scriptedKeychain({ load: "does-not-load" }));
    const chosen = await choose({ platform: "win32" });
    await chosen.vault.set("signing", SIGNING);
    expect(await fileVault(file).get("signing")).toBe(SIGNING);
    expect(chosen.reason).toBe(`The vault is the file ${file}: the OS keychain's binding, @napi-rs/keyring, did not load: Cannot find native binding for this platform.`);
  });

  it("keeps the vault in the file when the keychain fails its first call, moving nothing into it", async () => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("signing", SIGNING);
    keychain.fail = () => new Error("User interaction is not allowed.");
    const chosen = await choose();
    expect(await chosen.vault.get("signing")).toBe(SIGNING);
    await chosen.vault.set("forge-a", FORGE);
    expect(await fileVault(file).keys()).toEqual(["signing", "forge-a"]);
    expect(keychain.calls).toHaveLength(1);
    expect(chosen.reason).toBe(`The vault is the file ${file}: the OS keychain failed its first call: User interaction is not allowed.`);
  });
});

describe("the keychain vault", () => {
  it("keeps an entry across a restart, and answers undefined for one never stored", async () => {
    const { choose } = machine();
    await (await choose()).vault.set("signing", SIGNING);
    const restarted = (await choose()).vault;
    expect(await restarted.get("signing")).toBe(SIGNING);
    expect(await restarted.get("missing")).toBeUndefined();
  });

  it("deletes an entry, keeping the others, and deletes an absent one as no error", async () => {
    const { keychain, choose } = machine();
    const { vault } = await choose();
    await vault.set("signing", SIGNING);
    await vault.set("forge-a", FORGE);
    await vault.delete("signing");
    await vault.delete("missing");
    expect(await vault.get("signing")).toBeUndefined();
    expect(await vault.get("forge-a")).toBe(FORGE);
    expect(keychain.accounts(SERVICE)).toEqual(["forge-a"]);
  });

  it("lists the keys it holds, across a restart, none before anything was stored", async () => {
    const { choose } = machine();
    const { vault } = await choose();
    expect(await vault.keys()).toEqual([]);
    await vault.set("signing", SIGNING);
    await vault.set("forge-a", FORGE);
    await vault.set("signing", `${SIGNING}-2`);
    await vault.delete("forge-a");
    expect(await (await choose()).vault.keys()).toEqual(["signing"]);
  });

  it("keeps the keys in an index beside it that only its owner can read, and no value in it", async () => {
    const { dataDir, choose } = machine();
    const { vault } = await choose();
    await vault.set("signing", SIGNING);
    await vault.set("forge-a", FORGE);
    const index = join(dataDir, KEYCHAIN_INDEX_FILE);
    expect(JSON.parse(readFileSync(index, "utf8"))).toEqual({ service: SERVICE, keys: ["signing", "forge-a"] });
    if (posix) expect(statSync(index).mode & 0o777).toBe(0o600);
  });

  it("fails a write the keychain fails, leaving the entry it would have replaced, and lists no key the write would have added", async () => {
    const { keychain, choose } = machine();
    const { vault } = await choose();
    await vault.set("signing", SIGNING);
    keychain.fail = (call) => (call.op === "set" ? new Error("the keychain is locked") : undefined);
    await expect(vault.set("signing", `${SIGNING}-2`)).rejects.toThrow(/locked/);
    await expect(vault.set("forge-a", FORGE)).rejects.toThrow(/locked/);
    expect(await vault.get("signing")).toBe(SIGNING);
    expect(await vault.keys()).toEqual(["signing"]);
  });

  it("keeps the service a restart finds in its index, whatever the environment's id names", async () => {
    const { keychain, choose } = machine();
    await (await choose()).vault.set("signing", SIGNING);
    const restarted = await choose({ environmentId: "another-id" });
    expect(await restarted.vault.get("signing")).toBe(SIGNING);
    await restarted.vault.set("forge-a", FORGE);
    expect(keychain.accounts(SERVICE)).toEqual(["signing", "forge-a"]);
  });
});

describe("the move into the keychain", () => {
  it("moves the file's entries into the keychain at its first successful use, each written, read back, and only then removed from the file", async () => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("signing", SIGNING);
    await fileVault(file).set("forge-a", FORGE);
    const seen: string[] = [];
    keychain.fail = (call) => {
      if (call.account !== "probe") seen.push(`${call.op} ${call.account}, file ${fileHolds(file, call.account) ? "holds it" : "does not"}`);
      return undefined;
    };
    const chosen = await choose();
    expect(seen).toEqual([
      "set signing, file holds it",
      "get signing, file holds it",
      "set forge-a, file holds it",
      "get forge-a, file holds it",
    ]);
    expect(await fileVault(file).keys()).toEqual([]);
    expect(keychain.entry(SERVICE, "signing")).toBe(SIGNING);
    expect(keychain.entry(SERVICE, "forge-a")).toBe(FORGE);
    expect(await chosen.vault.keys()).toEqual(["signing", "forge-a"]);
    expect(chosen.reason).toBe(`The vault is the OS keychain, service "${SERVICE}": 2 entries moved into it from the file ${file}.`);
    expect((await choose()).reason).toBe(`The vault is the OS keychain, service "${SERVICE}": the file ${file} held nothing to move into it.`);
  });

  it("loses nothing when the keychain fails part way: what did not move stays in the file, is read from there, and moves at the next start", async () => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("signing", SIGNING);
    await fileVault(file).set("forge-a", FORGE);
    keychain.fail = (call) => (call.op === "set" && call.account === "forge-a" ? new Error("The keychain is full.") : undefined);
    const chosen = await choose();
    expect(await fileVault(file).keys()).toEqual(["forge-a"]);
    expect(await chosen.vault.get("signing")).toBe(SIGNING);
    expect(await chosen.vault.get("forge-a")).toBe(FORGE);
    expect(await chosen.vault.keys()).toEqual(["signing", "forge-a"]);
    expect(chosen.reason).toBe(
      `The vault is the OS keychain, service "${SERVICE}": 1 entry moved into it from the file ${file}, and 1 stays there until a start moves it (forge-a): forge-a: The keychain is full.`,
    );

    keychain.fail = () => undefined;
    const next = await choose();
    expect(await fileVault(file).keys()).toEqual([]);
    expect(keychain.entry(SERVICE, "forge-a")).toBe(FORGE);
    expect(next.reason).toBe(`The vault is the OS keychain, service "${SERVICE}": 1 entry moved into it from the file ${file}.`);
  });

  it("leaves an entry in the file when the keychain reads it back as another value, and answers the file's", async () => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("forge-a", FORGE);
    keychain.mangle = (call) => call.account === "forge-a";
    const chosen = await choose();
    expect(await fileVault(file).get("forge-a")).toBe(FORGE);
    expect(await chosen.vault.get("forge-a")).toBe(FORGE);
    expect(chosen.reason).toBe(
      `The vault is the OS keychain, service "${SERVICE}": 0 entries moved into it from the file ${file}, and 1 stays there until a start moves it (forge-a): forge-a: the keychain read it back as another value.`,
    );
  });

  it("writes an entry the file still holds into the keychain and removes it from the file, and deletes one from both", async () => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("signing", SIGNING);
    await fileVault(file).set("forge-a", FORGE);
    keychain.fail = (call) => (call.op === "set" ? new Error("The keychain is locked.") : undefined);
    const { vault } = await choose();
    keychain.fail = () => undefined;
    await vault.set("signing", `${SIGNING}-2`);
    expect(await fileVault(file).keys()).toEqual(["forge-a"]);
    expect(await vault.get("signing")).toBe(`${SIGNING}-2`);
    await vault.delete("forge-a");
    expect(await fileVault(file).keys()).toEqual([]);
    expect(await vault.get("forge-a")).toBeUndefined();
    expect(await vault.keys()).toEqual(["signing"]);
  });

  it("puts no entry's value in its line, even when the keychain's error carries one", async () => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("signing", SIGNING);
    await fileVault(file).set("forge-a", FORGE);
    keychain.fail = (call) => (call.op === "set" && call.account === "forge-a" ? new Error(`Could not store ${call.value ?? ""} for ${call.account}.`) : undefined);
    const { reason } = await choose();
    expect(reason).toContain("forge-a: Could not store [redacted] for forge-a");
    expect(reason).not.toContain(FORGE);
    expect(reason).not.toContain(SIGNING);
  });
});

describe("the chosen vault as the environment holds it", () => {
  it.each([
    ["the file, on Linux", { platform: "linux" } as const, () => undefined],
    ["the keychain, after the move", {}, () => undefined],
    ["the keychain, with an entry the move left in the file", {}, (call: KeychainCall) => (call.op === "set" && call.account === "forge-a" ? new Error("The keychain is full.") : undefined)],
  ])("registers every entry with the scrub registry from start when the vault is %s", async (_, overrides, fail) => {
    const { file, keychain, choose } = machine();
    await fileVault(file).set("signing", SIGNING);
    await fileVault(file).set("forge-a", FORGE);
    keychain.fail = fail;
    const registry = createScrubRegistry();
    await holdVault((await choose(overrides)).vault, registry);
    expect(registry.scrub(`${SIGNING} ${FORGE}`)).toBe("[redacted] [redacted]");
  });

  it("registers from start the entries a service wrote into the keychain at an earlier start", async () => {
    const { choose } = machine();
    const first = await choose();
    await first.vault.set("signing", SIGNING);
    await first.vault.set("forge-a", FORGE);
    const registry = createScrubRegistry();
    await holdVault((await choose()).vault, registry);
    expect(registry.scrub(`${SIGNING} ${FORGE}`)).toBe("[redacted] [redacted]");
  });
});

describe("the keychain's binding", () => {
  it("keeps each value as its UTF-8 bytes in the binding's entry for the service and account, reads an absent one as undefined, and deletes an absent one as no error", async () => {
    const secrets = new Map<string, Uint8Array>();
    class Entry {
      readonly #at: string;
      constructor(service: string, account: string) {
        this.#at = `${service} / ${account}`;
      }
      getSecret = async () => secrets.get(this.#at) ?? null;
      setSecret = async (secret: Uint8Array) => void secrets.set(this.#at, secret);
      deleteCredential = async () => secrets.delete(this.#at);
    }
    const binding = await loadKeychainBinding(async () => ({ AsyncEntry: Entry }));
    await binding.set(SERVICE, "signing", "signing-value-é");
    expect(Buffer.from(secrets.get(`${SERVICE} / signing`) ?? []).toString("utf8")).toBe("signing-value-é");
    expect(await binding.get(SERVICE, "signing")).toBe("signing-value-é");
    expect(await binding.get(SERVICE, "missing")).toBeUndefined();
    await binding.delete(SERVICE, "missing");
    await binding.delete(SERVICE, "signing");
    expect(secrets.size).toBe(0);
  });
});

