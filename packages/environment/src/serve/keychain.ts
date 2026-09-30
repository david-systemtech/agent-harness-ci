import { join } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { readJsonFile, writeFileAtomic } from "./files.js";
import { fileVault, VAULT_FILE, type Vault } from "./vault.js";

/** The keychain's binding: an optional dependency with a prebuild per platform, so an install may lack it. */
export const KEYCHAIN_BINDING = "@napi-rs/keyring";

/**
 * The keychain vault's index in the data directory: the keychain service its
 * entries are under and their keys, never a value.
 */
export const KEYCHAIN_INDEX_FILE = "keychain.json";

/** The operating systems where the vault is the OS keychain. */
const KEYCHAIN_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

/** The account the chooser reads to learn whether the keychain answers; nothing is ever written there. */
const PROBE_ACCOUNT = "probe";

/**
 * The OS keychain as the vault reaches it: one entry per account under a
 * service, the macOS login keychain's generic passwords and the Windows
 * Credential Manager's generic credentials. The seam the tests script.
 */
export interface KeychainBinding {
  /** The entry's value, or undefined when there is none. */
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, value: string): Promise<void>;
  /** Removes the entry; an absent one is no error. */
  delete(service: string, account: string): Promise<void>;
}

/** The part of the binding's module the vault uses: an entry by service and account. */
interface KeyringModule {
  readonly AsyncEntry: new (
    service: string,
    account: string,
  ) => {
    getSecret(): Promise<Uint8Array | null | undefined>;
    setSecret(secret: Uint8Array): Promise<void>;
    deleteCredential(): Promise<boolean>;
  };
}

/**
 * The keychain's binding, `KEYCHAIN_BINDING`, loaded where the vault may be
 * the keychain; `load` is the import, which throws when the package is not
 * installed or its prebuild does not load. Values are kept as their UTF-8
 * bytes (the binding's secret calls, not its password calls, which on Windows
 * store UTF-16): Credential Manager holds at most 2,560 bytes an entry.
 */
export const loadKeychainBinding = async (load: () => Promise<KeyringModule> = () => import("@napi-rs/keyring")): Promise<KeychainBinding> => {
  const { AsyncEntry } = await load();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    get: async (service, account) => {
      const secret = await new AsyncEntry(service, account).getSecret();
      return secret === null || secret === undefined ? undefined : decoder.decode(secret);
    },
    set: (service, account, value) => new AsyncEntry(service, account).setSecret(encoder.encode(value)),
    delete: async (service, account) => {
      await new AsyncEntry(service, account).deleteCredential();
    },
  };
};

interface KeychainIndex {
  readonly service: string;
  readonly keys: readonly string[];
}

const isKeychainIndex = (value: unknown): value is KeychainIndex =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as KeychainIndex).service === "string" &&
  Array.isArray((value as KeychainIndex).keys) &&
  (value as KeychainIndex).keys.every((key) => typeof key === "string");

/** The index at `path`, undefined before the keychain vault's first write; one that is not an index is refused, never replaced. */
const readKeychainIndex = (path: string): KeychainIndex | undefined => readJsonFile(path, isKeychainIndex, "a keychain index");

/**
 * The vault in the OS keychain: each entry under `service`, its key the
 * entry's account. The keys are listed in the index at `indexPath`, since the
 * binding lists a service's entries only by reading every value, and on
 * Windows by a filter the platform documents for prefixes alone. A key is
 * listed before its entry is written, and unlisted once the entry is deleted
 * or its first write failed, so every entry the vault wrote is listed; a
 * listed key with no entry reads as absent.
 */
const keychainVault = (binding: KeychainBinding, service: string, indexPath: string): Vault => {
  const listed = (): readonly string[] => readKeychainIndex(indexPath)?.keys ?? [];
  const list = (keys: readonly string[]): void => writeFileAtomic(indexPath, `${JSON.stringify({ service, keys }, null, 2)}\n`, 0o600);
  return {
    get: (key) => binding.get(service, key),
    set: async (key, value) => {
      const added = !listed().includes(key);
      if (added) list([...listed(), key]);
      try {
        await binding.set(service, key, value);
      } catch (error) {
        if (added) list(listed().filter((each) => each !== key));
        throw error;
      }
    },
    delete: async (key) => {
      await binding.delete(service, key);
      if (listed().includes(key)) list(listed().filter((each) => each !== key));
    },
    keys: async () => listed(),
  };
};

/**
 * The keychain with the entries a move left in the file behind it, until a
 * later start moves them: an entry the file still holds is read from there,
 * since it did not reach the keychain whole; a write goes to the keychain and
 * then takes the file's copy away; a delete takes both.
 */
const keychainOverFile = (keychain: Vault, file: Vault): Vault => ({
  get: async (key) => (await file.get(key)) ?? keychain.get(key),
  set: async (key, value) => {
    await keychain.set(key, value);
    await file.delete(key);
  },
  delete: async (key) => {
    await keychain.delete(key);
    await file.delete(key);
  },
  keys: async () => [...new Set([...(await keychain.keys()), ...(await file.keys())])],
});

/** An error's message on one line, for the chooser's log line. */
const said = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ").replace(/\.$/, "");

/** What a move did: how many entries it moved, the keys it left in the file, and why the first of those stayed. */
interface Move {
  readonly moved: number;
  readonly left: readonly string[];
  readonly failure: string | undefined;
}

/**
 * Moves every entry of `file` into `keychain`: each is written, read back,
 * and only then removed from the file, so the file keeps an entry until the
 * keychain is known to hold it whole. An entry that fails stays, and the move
 * goes on to the next. The file's copy replaces the keychain's: the file takes
 * writes only at a start whose vault it is, so its copy is the later one.
 * What the keychain said of a failure is kept with every value the move
 * handled taken out of it.
 */
const move = async (file: Vault, keychain: Vault): Promise<Move> => {
  const values: string[] = [];
  const left: string[] = [];
  let moved = 0;
  let failure: string | undefined;
  for (const key of await file.keys()) {
    const value = await file.get(key);
    if (value === undefined) continue;
    values.push(value);
    try {
      await keychain.set(key, value);
      if ((await keychain.get(key)) !== value) throw new Error("the keychain read it back as another value");
      await file.delete(key);
      moved += 1;
    } catch (error) {
      left.push(key);
      failure ??= `${key}: ${said(error)}`;
    }
  }
  const redacted = values.filter((value) => value !== "").sort((a, b) => b.length - a.length);
  return { moved, left, failure: redacted.reduce((text, value) => text?.replaceAll(value, "[redacted]"), failure) };
};

/** What the vault chooser decides from. */
export interface VaultChoice {
  /** The operating system the environment runs on. */
  readonly platform: NodeJS.Platform;
  /** Whether a launcher started the environment: what the user's launch agent (macOS) or logon task (Windows) runs. */
  readonly asService: boolean;
  /** The data directory, which holds the file vault and the keychain vault's index. */
  readonly dataDir: string;
  /** The environment's id, which names the keychain service its entries go under until the index names one. */
  readonly environmentId: string;
  /** Loads the keychain's binding; throws when it is not installed or does not load. */
  readonly loadBinding: () => Promise<KeychainBinding>;
}

/** The vault a start holds, and the one line it logs saying which it is and why. */
export interface ChosenVault {
  readonly vault: Vault;
  readonly reason: string;
}

/**
 * The vault chooser (ADR 0011: a keychain on a desktop, a 0600 file on a
 * headless machine; key-managers spec, "The vault on a desktop"; #364). On macOS and Windows, where a launcher started the
 * environment (the service's launch agent or logon task runs one), the vault
 * is the OS keychain through its binding, under the service the index names,
 * else `<product> <environment id>`. Elsewhere, or where the binding is not
 * installed, does not load or fails its first call, it is the file vault in
 * the data directory. The first start the keychain answers at moves the
 * file's entries into it (`move`); what does not move stays in the file,
 * read from there until a later start moves it. The reason names no value:
 * a keychain's error has every value the move handled taken out.
 */
export const chooseVault = async (choice: VaultChoice): Promise<ChosenVault> => {
  const path = join(choice.dataDir, VAULT_FILE);
  const file = fileVault(path);
  const inFile = (why: string): ChosenVault => ({ vault: file, reason: `The vault is the file ${path}: ${why}.` });
  if (!KEYCHAIN_PLATFORMS.has(choice.platform)) return inFile(`the OS keychain is the vault on macOS and Windows only, and this machine runs ${choice.platform}`);
  if (!choice.asService) {
    const runner = choice.platform === "darwin" ? "launch agent" : "logon task";
    return inFile(`the OS keychain is the vault only where the environment runs as the user's ${runner}, and no launcher started this one`);
  }
  let binding: KeychainBinding;
  try {
    binding = await choice.loadBinding();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return inFile(`the OS keychain's binding, ${KEYCHAIN_BINDING}, is not installed`);
    return inFile(`the OS keychain's binding, ${KEYCHAIN_BINDING}, did not load: ${said(error)}`);
  }
  const indexPath = join(choice.dataDir, KEYCHAIN_INDEX_FILE);
  const service = readKeychainIndex(indexPath)?.service ?? `${PRODUCT_NAME} ${choice.environmentId}`;
  // One that fails leaves the vault in the file for this start, and what the file holds moves at a later one.
  try {
    await binding.get(service, PROBE_ACCOUNT);
  } catch (error) {
    return inFile(`the OS keychain failed its first call: ${said(error)}`);
  }
  const keychain = keychainVault(binding, service, indexPath);
  const { moved, left, failure } = await move(file, keychain);
  const inKeychain = `The vault is the OS keychain, service "${service}"`;
  const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;
  if (moved === 0 && left.length === 0) return { vault: keychain, reason: `${inKeychain}: the file ${path} held nothing to move into it.` };
  if (left.length === 0) return { vault: keychain, reason: `${inKeychain}: ${entries(moved)} moved into it from the file ${path}.` };
  const stay = left.length === 1 ? "1 stays there until a start moves it" : `${left.length} stay there until a start moves them`;
  return {
    vault: keychainOverFile(keychain, file),
    reason: `${inKeychain}: ${entries(moved)} moved into it from the file ${path}, and ${stay} (${left.join(", ")}): ${failure ?? ""}.`,
  };
};
