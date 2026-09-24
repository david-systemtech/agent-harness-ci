import { chmodSync, readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "./files.js";

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
const posixModes = process.platform !== "win32";

/**
 * A vault in one JSON file of string values, mode 0600, replaced by rename on
 * every write. A file that is not a JSON object of strings is refused, never
 * overwritten: it may hold the only copy of a key.
 */
export const fileVault = (path: string): Vault => {
  const read = (): Record<string, string> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    if (posixModes && (statSync(path).mode & 0o077) !== 0) chmodSync(path, OWNER_ONLY);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((value) => typeof value === "string")
    ) {
      throw new Error(`The vault ${path} is not a JSON object of strings; refusing to read or replace it.`);
    }
    return parsed as Record<string, string>;
  };

  return {
    get: async (key) => {
      const entries = read();
      return Object.hasOwn(entries, key) ? entries[key] : undefined;
    },
    set: async (key, value) => {
      const entries = { ...read(), [key]: value };
      writeFileAtomic(path, `${JSON.stringify(entries, null, 2)}\n`, OWNER_ONLY);
    },
  };
};
