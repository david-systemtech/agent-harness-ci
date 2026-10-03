import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretAccess, ShellPlatform, ShellSecrets } from "@agent-harness/client-runtime";
import type { ElectronSafeStorage } from "./electron.js";

/**
 * The shell's `secrets` (docs/specs/gui.md, "The desktop shell"): the client
 * session tokens the runtime keeps by environment id, one file each in the
 * desktop's data directory, `secrets/<name>.secret`, encrypted by Electron's
 * `safeStorage` under the key the OS keeps for the app: the macOS Keychain,
 * Windows' DPAPI, a Linux secret service. Each file is written whole and
 * renamed into place, readable by its owner alone. On macOS all availability,
 * encryption and decryption use the async provider: Keychain approval waits
 * on a worker thread, including reading ciphertext kept by synchronous storage.
 *
 * On Linux with no secret service answering, Chromium chooses its
 * `basic_text` store and `safeStorage` refuses to encrypt unless asked to use
 * Chromium's fixed key (Electron 44's `IsEncryptionAvailable`), which keeps a
 * token no safer than its file's permissions. The desktop asks, so pairing
 * works there, and says once that tokens are stored unprotected; it tells the
 * renderer through `protection`, and the Your machines card (#416) says so too.
 */

export interface KeychainParts {
  readonly safeStorage: ElectronSafeStorage;
  readonly os: ShellPlatform;
  /** The folder the files are kept in. */
  readonly dir: string;
  /** Hears the fall back to the fixed key, and a token that could not be read. */
  readonly report: (error: unknown) => void;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const keychainSecrets = ({ safeStorage, os, dir, report }: KeychainParts): Required<ShellSecrets> => {
  let unprotected = false;
  let state: SecretAccess = null;
  let pending = 0;
  let denied = false;
  const listeners = new Set<(state: SecretAccess) => void>();
  const publish = () => {
    state = pending > 0 ? "waiting" : denied ? "denied" : null;
    for (const listener of [...listeners]) listener(state);
  };
  const macKeychain = async <T>(operation: () => Promise<T>): Promise<T> => {
    pending++;
    denied = false;
    publish();
    try {
      return await operation();
    } catch (error) {
      denied = true;
      throw error;
    } finally {
      pending--;
      publish();
    }
  };
  /** Whether `safeStorage` encrypts now: on Linux with no secret service, once it takes Chromium's fixed key. */
  const encrypts = (): boolean => {
    if (safeStorage.isEncryptionAvailable()) return true;
    if (os !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text") return false;
    safeStorage.setUsePlainTextEncryption(true);
    if (!unprotected) {
      unprotected = true;
      report(
        new Error(
          "No secret service answers on this Linux session, so client session tokens are stored unprotected: " +
            "under Chromium's fixed key, as safe as their files' permissions and no safer.",
        ),
      );
    }
    return safeStorage.isEncryptionAvailable();
  };
  const fileOf = (name: string): string => {
    if (name === "") throw new TypeError("A secret's name must not be empty.");
    return join(dir, `${encodeURIComponent(name)}.secret`);
  };
  return {
    async get(name) {
      const file = fileOf(name);
      // A token that cannot be read is none, never a rejection the runtime has no answer for: it blocks the connection as
      // revoked, and pairing again replaces the token.
      try {
        const kept = await readFile(file);
        if (os === "darwin") return await macKeychain(async () => (await safeStorage.decryptStringAsync(kept)).result);
        if (!encrypts()) throw new Error("the OS keeps no key for this app now");
        return safeStorage.decryptString(kept);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        const retry = os === "darwin" ? "The saved token is kept; allow Keychain access and retry. If access stays unavailable, restart this desktop." : "Pair that environment again.";
        report(new Error(`The desktop cannot read the token kept for ${name} (${reasonOf(error)}). ${retry}`));
        return undefined;
      }
    },
    async set(name, secret) {
      const file = fileOf(name);
      if (os !== "darwin" && !encrypts()) {
        throw new Error("This desktop cannot keep a client session token: the OS keeps no key for it (safeStorage cannot encrypt). Unlock or set up the system keychain, then pair again.");
      }
      const encrypted = os === "darwin" ? await macKeychain(async () => {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("This desktop cannot keep a client session token: unlock or set up the system keychain, then pair again.");
        return safeStorage.encryptStringAsync(secret);
      }) : safeStorage.encryptString(secret);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (os !== "win32") await chmod(dir, 0o700);
      const next = `${file}.${randomUUID()}.next`;
      try {
        await writeFile(next, encrypted, { mode: 0o600 });
        await rename(next, file);
      } catch (error) {
        await rm(next, { force: true });
        throw error;
      }
    },
    async delete(name) {
      await rm(fileOf(name), { force: true });
    },
    async access() { return state; },
    onAccess(listener) {
      listeners.add(listener);
      listener(state);
      return () => void listeners.delete(listener);
    },
    async protection() {
      if (os === "darwin") return await macKeychain(async () => await safeStorage.isAsyncEncryptionAvailable() ? "os" : "none");
      if (!encrypts()) return "none";
      return unprotected ? "unprotected" : "os";
    },
  };
};
