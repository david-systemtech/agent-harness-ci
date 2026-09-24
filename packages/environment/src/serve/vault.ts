import { chmodSync, statSync } from "node:fs";
import { readJsonFile, writeFileAtomic } from "./files.js";

/**
 * Where an environment keeps its secrets: the client-session signing key now,
 * key-manager credentials later. On a headless machine it is `fileVault`, a
 * file in the data directory only the OS user can read. On a desktop the
 * secrets belong in the OS keychain; that implementation comes with the
 * desktop shell (milestone 1 phase B, the GUI workstream) and is out of scope
 * here, which is why the interface is asynchronous, as keychain APIs are.
 */
export interface Vault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
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

  return {
    get: async (key) => {
      const entries = read();
      return Object.hasOwn(entries, key) ? entries[key] : undefined;
    },
    set: async (key, value) => {
      writeFileAtomic(path, `${JSON.stringify({ ...read(), [key]: value }, null, 2)}\n`, OWNER_ONLY);
    },
  };
};
