import { chmodSync, statSync } from "node:fs";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import { readJsonFile, writeFileAtomic } from "./files.js";

/**
 * Where an environment keeps its secrets: the client-session signing key now,
 * key-manager credentials and forge tokens later. On a headless machine it is
 * `fileVault`, a file in the data directory only the OS user can read. On
 * macOS and Windows, under the user's launch agent or logon task, it is the
 * OS keychain (`keychain.ts`, #364), which is why the interface is
 * asynchronous, as keychain APIs are.
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

/**
 * The vault as the environment holds it (ADR 0011, key-managers spec, "Who
 * registers"): every entry registered with the scrub registry, as
 * `vault:<key>`, for as long as the vault holds it. The entries there are
 * registered before this answers, so the environment takes hold of its vault
 * at start, before the wire opens. A value set is registered before it is
 * written, and a value it replaces released once the write is done; a deleted
 * entry is released once the delete is done; a read that finds an entry
 * changed or gone outside the environment registers what it finds and lets
 * the old value go. The calls on one key run one at a time, in the order they
 * were made, so a read that began before a write never answers after it with
 * the value the write replaced.
 */
export const holdVault = async (vault: Vault, registry: ScrubRegistry): Promise<Vault> => {
  interface Held {
    readonly value: string;
    readonly release: ScrubRelease;
  }
  const held = new Map<string, Held>();
  const register = (key: string, value: string): Held => ({ value, release: registry.register(value, { owner: `vault:${key}` }) });
  /** Holds `next` for `key`, or nothing, then lets go of what was held: a value both hold is never unregistered between. */
  const replace = (key: string, next: Held | undefined): void => {
    const current = held.get(key);
    if (next === undefined) held.delete(key);
    else held.set(key, next);
    current?.release();
  };
  /** Holds what a read found for `key`, unless it is what is held already. */
  const found = (key: string, value: string | undefined): void => {
    if (held.get(key)?.value !== value) replace(key, value === undefined ? undefined : register(key, value));
  };
  /** The last call on each key still running: the next waits for it, whether it succeeded or failed. */
  const running = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const answer = (running.get(key) ?? Promise.resolve()).then(work, work);
    const settled = answer.catch(() => undefined);
    running.set(key, settled);
    void settled.then(() => {
      if (running.get(key) === settled) running.delete(key);
    });
    return answer;
  };
  for (const key of await vault.keys()) found(key, await vault.get(key));

  return {
    get: (key) =>
      inTurn(key, async () => {
        const value = await vault.get(key);
        found(key, value);
        return value;
      }),
    set: (key, value) =>
      inTurn(key, async () => {
        const next = register(key, value);
        try {
          await vault.set(key, value);
        } catch (error) {
          next.release();
          throw error;
        }
        replace(key, next);
      }),
    delete: (key) =>
      inTurn(key, async () => {
        await vault.delete(key);
        replace(key, undefined);
      }),
    keys: () => vault.keys(),
  };
};
