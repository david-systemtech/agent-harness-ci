import { chmodSync, statSync } from "node:fs";
import { readJsonFile, writeFileAtomic } from "./files.js";

/**
 * Where an environment keeps its secrets: the client-session signing key now,
 * key-manager credentials and forge tokens later. On a headless machine it is
 * `fileVault`, a file in the data directory only the OS user can read. On a
 * desktop the secrets belong in the OS keychain; that implementation comes
 * with the desktop shell (milestone 1 phase B, the GUI workstream) and is out
 * of scope here, which is why the interface is asynchronous, as keychain APIs
 * are.
 */
export interface Vault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Removes an entry; an absent one is no error. */
  delete(key: string): Promise<void>;
  /** The keys of every entry: what the environment registers for scrubbing at start. */
  keys(): Promise<readonly string[]>;
}

/** The file vault's name in the data directory. */
export const VAULT_FILE = "vault.json";

const OWNER_ONLY = 0o600;

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

/**
 * A vault in one JSON file of string values, mode 0600, replaced by rename on
 * every write. Opening it tightens a file someone loosened. A file that is not
 * a JSON object of strings is refused, never overwritten: it may hold the only
 * copy of a key.
 */
export const fileVault = (path: string): Vault => {
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, OWNER_ONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const read = (): Record<string, string> => readJsonFile(path, isStringRecord, "a vault of strings") ?? {};
  const write = (entries: Record<string, string>): void => writeFileAtomic(path, `${JSON.stringify(entries, null, 2)}\n`, OWNER_ONLY);

  return {
    get: async (key) => {
      const entries = read();
      return Object.hasOwn(entries, key) ? entries[key] : undefined;
    },
    set: async (key, value) => write({ ...read(), [key]: value }),
    delete: async (key) => {
      const entries = read();
      if (!Object.hasOwn(entries, key)) return;
      delete entries[key];
      write(entries);
    },
    keys: async () => Object.keys(read()),
  };
};
