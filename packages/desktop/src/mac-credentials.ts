import type { SecretStorage } from "@agent-harness/client-runtime";
import { spawn, type ChildProcess } from "node:child_process";
import type { ElectronSafeStorage } from "./electron.js";

/** The same signed app, without a window or single-instance lock, owns native Keychain waits. */
export const CREDENTIAL_HELPER_ARGUMENT = "--credential-helper";
export interface MacCredentials {
  available(signal: AbortSignal): Promise<boolean>;
  encrypt(secret: string, signal: AbortSignal): Promise<Buffer>;
  decrypt(kept: Buffer, signal: AbortSignal): Promise<string>;
  /** Storage path for this encrypted write; native providers have no envelope. */
  writeStorage?(encrypted: Buffer): SecretStorage;
  /** Rotates new writes away from an unavailable earlier OS item. */
  recover?(kept: Buffer): Promise<void>;
  /** Whether an earlier unavailable item's ciphertext still needs re-pairing. */
  recovery?(): Promise<boolean>;
  close(): void;
}

type Payload = { kind: "available" } | { kind: "encrypt" | "decrypt"; value: string };
type Request = { id: number } & Payload;
type Reply = { id: number; value: string | boolean } | { id: number; error: string };
export type CredentialChild = Pick<ChildProcess, "on" | "send" | "kill">;

/** A cancelled provider is discarded as a whole: Electron caches its pending initialization. */
export const macCredentialProcess = (launch: () => CredentialChild): MacCredentials => {
  let child: CredentialChild | undefined;
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, { resolve(value: string | boolean): void; reject(error: Error): void }>();
  const reset = (error: Error) => {
    const previous = child;
    child = undefined;
    // SIGTERM can itself wait on the native Keychain worker. Only this app's own helper is killed.
    previous?.kill("SIGKILL");
    for (const answer of pending.values()) answer.reject(error);
    pending.clear();
  };
  const request = (payload: Payload, signal: AbortSignal): Promise<string | boolean> => new Promise((resolve, reject) => {
    if (closed || signal.aborted) return reject(new Error("Desktop credential access was cancelled."));
    const id = ++nextId;
    const abort = () => reset(new Error("Keychain provider access was cancelled; retry to request access again."));
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => signal.removeEventListener("abort", abort);
    pending.set(id, {
      resolve: (value) => { finish(); resolve(value); },
      reject: (error) => { finish(); reject(error); },
    });
    try {
      if (!child) {
        const started = launch();
        child = started;
        started.on("message", (message: Reply) => {
          if (child !== started || typeof message !== "object" || message === null) return;
          const answer = pending.get(message.id);
          if (!answer) return;
          pending.delete(message.id);
          if ("error" in message) {
            const error = new Error(message.error);
            reset(error);
            answer.reject(error);
          } else {
            if (message.value === false) reset(new Error("The Keychain provider is unavailable; retry to request access again."));
            answer.resolve(message.value);
          }
        });
        const lost = () => { if (child === started) reset(new Error("The Keychain helper exited; retry to request access again.")); };
        started.on("error", lost);
        started.on("exit", lost);
      }
      const started = child;
      started.send({ ...payload, id }, (error) => { if (error && child === started) reset(new Error("The Keychain helper could not receive the request.")); });
    } catch { reset(new Error("The Keychain helper could not start.")); }
  });
  return {
    available: async (signal) => (await request({ kind: "available" }, signal)) === true,
    encrypt: async (value, signal) => Buffer.from(String(await request({ kind: "encrypt", value }, signal)), "base64"),
    decrypt: async (kept, signal) => String(await request({ kind: "decrypt", value: kept.toString("base64") }, signal)),
    close() { closed = true; reset(new Error("Desktop credential access was cancelled at shutdown.")); },
  };
};

export const launchMacCredentials = (executable: string, appArgs: readonly string[], name = "agent-harness"): MacCredentials => macCredentialProcess(() => {
  // No credentials in arguments, environment, stdout or stderr. Node's private IPC pipe carries them.
  const environment = { ...process.env };
  delete environment["ELECTRON_RUN_AS_NODE"];
  return spawn(executable, [...appArgs, CREDENTIAL_HELPER_ARGUMENT, `--credential-store=${name}`], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json", env: environment,
  });
});

/** The helper's IPC boundary. Importing this module never loads Electron. */
export const serveMacCredentials = (
  storage: ElectronSafeStorage,
  ready: Promise<void>,
  receive: (listener: (request: Request) => void) => void,
  send: (reply: Reply) => void,
): void => {
  receive((request) => {
    void (async () => {
      try {
        await ready;
        let value: string | boolean;
        switch (request.kind) {
          case "available": value = await storage.isAsyncEncryptionAvailable(); break;
          case "encrypt":
            if (!(await storage.isAsyncEncryptionAvailable())) throw new Error("Unlock or set up the system keychain, then pair again.");
            value = (await storage.encryptStringAsync(request.value)).toString("base64"); break;
          case "decrypt": value = (await storage.decryptStringAsync(Buffer.from(request.value, "base64"))).result; break;
          default: throw new Error("Unknown credential operation.");
        }
        send({ id: request.id, value });
      } catch {
        // Native errors can contain the plaintext passed in; only the action's safe reason crosses IPC.
        send({ id: request.id, error: "macOS Keychain access was refused or unavailable. Allow access and retry." });
      }
    })();
  });
};
