import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialAccessUnansweredError, StoredCredentialUnavailableError, type Clock, type SecretAccess, type ShellPlatform, type ShellSecrets } from "@agent-harness/client-runtime";
import type { MacCredentials } from "./mac-credentials.js";
import type { ElectronSafeStorage } from "./electron.js";

/**
 * The shell's `secrets` (docs/specs/gui.md, "The desktop shell"): the client
 * session tokens the runtime keeps by environment id, one file each in the
 * desktop's data directory, `secrets/<name>.secret`, encrypted by Electron's
 * `safeStorage` under the key the OS keeps for the app: the macOS Keychain,
 * Windows' DPAPI, a Linux secret service. Each file is written whole and
 * renamed into place, readable by its owner alone. On macOS all availability,
 * encryption and decryption use the async provider in a disposable helper app:
 * a pending OS request never owns the window's process, including when reading
 * ciphertext kept by synchronous storage. Calls expire after 30 seconds.
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
  readonly clock?: Clock;
  /** Production macOS access runs in a cancellable helper, outside this process. */
  readonly macCredentials?: MacCredentials;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const KEYCHAIN_TIMEOUT_MS = 30_000;
const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface KeychainSecrets extends Required<ShellSecrets> {
  close(): void;
}

export const keychainSecrets = ({ safeStorage, os, dir, report, clock = SYSTEM_CLOCK, macCredentials }: KeychainParts): KeychainSecrets => {
  const mac = macCredentials ?? {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (secret: string) => safeStorage.encryptStringAsync(secret),
    decrypt: async (kept: Buffer) => (await safeStorage.decryptStringAsync(kept)).result,
    close: () => {},
  };
  let closed = false;
  const requests = new Set<AbortController>();
  let unprotected = false;
  let state: SecretAccess = null;
  let pending = 0;
  let denied = false;
  const listeners = new Set<(state: SecretAccess) => void>();
  const publish = () => {
    const next = pending > 0 ? "waiting" : denied ? "denied" : null;
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  };
  const recovery = async () => {
    if (mac.recovery) { denied = await mac.recovery(); publish(); }
  };
  /**
   * Only a failed read of kept ciphertext is `denied`: a write or an availability check that
   * fails leaves the state as it was, since a fresh install has no earlier item to warn of.
   * A read or a write that succeeds settles the state from the recovery metadata.
   */
  const macKeychain = async <T>(kind: "read" | "write" | "availability", operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("Desktop credential access was cancelled at shutdown.");
    const request = new AbortController();
    requests.add(request);
    pending++;
    publish();
    const cancelled = new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    const timer = clock.setTimeout(() => request.abort(new CredentialAccessUnansweredError(KEYCHAIN_TIMEOUT_MS / 1000)), KEYCHAIN_TIMEOUT_MS);
    try {
      // Race only observes the result. A late native answer cannot publish or write a token.
      const answer = await Promise.race([operation(request.signal), cancelled]);
      if (kind !== "availability") denied = mac.recovery ? await mac.recovery() : false;
      return answer;
    } catch (error) {
      if (kind === "read") denied = true;
      throw error;
    } finally {
      timer.cancel();
      requests.delete(request);
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
      let kept: Buffer | undefined;
      // A refused earlier OS item remains on disk and blocks re-pairably, without revocation.
      try {
        const bytes = await readFile(file);
        kept = bytes;
        if (os === "darwin") return await macKeychain("read", (signal) => mac.decrypt(bytes, signal));
        if (!encrypts()) throw new Error("the OS keeps no key for this app now");
        return safeStorage.decryptString(kept);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        if (os === "darwin" && kept && !closed) {
          await mac.recover?.(kept);
          await recovery();
          const unavailable = new StoredCredentialUnavailableError(`The desktop could not read ${name} (${reasonOf(error)}).`);
          report(unavailable);
          throw unavailable;
        }
        const retry = os === "darwin" ? "The saved token is kept. In Your machines, choose Try again and allow macOS Keychain access when prompted." : "Pair that environment again.";
        const unreadable = new Error(`The desktop cannot read the token kept for ${name} (${reasonOf(error)}). ${retry}`);
        report(unreadable);
        if (os === "darwin") throw unreadable;
        return undefined;
      }
    },
    async set(name, secret) {
      const file = fileOf(name);
      if (os !== "darwin" && !encrypts()) {
        throw new Error("This desktop cannot keep a client session token: the OS keeps no key for it (safeStorage cannot encrypt). Unlock or set up the system keychain, then pair again.");
      }
      const encrypted = os === "darwin" ? await macKeychain("write", async (signal) => {
        if (!(await mac.available(signal))) throw new Error("This desktop cannot keep a client session token: unlock or set up the system keychain, then pair again.");
        return mac.encrypt(secret, signal);
      }) : safeStorage.encryptString(secret);
      if (closed) throw new Error("Desktop credential access was cancelled at shutdown.");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (os !== "win32") await chmod(dir, 0o700);
      const next = `${file}.${randomUUID()}.next`;
      try {
        await writeFile(next, encrypted, { mode: 0o600 });
        if (closed) throw new Error("Desktop credential access was cancelled at shutdown.");
        await rename(next, file);
        await recovery();
        return os === "darwin" ? mac.writeStorage?.(encrypted) : undefined;
      } catch (error) {
        await rm(next, { force: true });
        throw error;
      }
    },
    close() {
      closed = true;
      for (const request of requests) request.abort(new Error("Desktop credential access was cancelled at shutdown."));
      mac.close();
    },
    async delete(name) {
      await rm(fileOf(name), { force: true });
      await recovery();
    },
    async access() { await recovery(); return state; },
    onAccess(listener) {
      listeners.add(listener);
      listener(state);
      void recovery().catch(report);
      return () => void listeners.delete(listener);
    },
    async protection() {
      if (os === "darwin") return await macKeychain("availability", (signal) => mac.available(signal)) ? "os" : "none";
      if (!encrypts()) return "none";
      return unprotected ? "unprotected" : "os";
    },
  };
};
