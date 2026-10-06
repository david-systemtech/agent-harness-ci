import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_ACCESS_FILE, type CredentialAccessState } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { clearCredentialAccess, CREDENTIAL_WAIT_AFTER_MS, credentialAccessReporter, watchCredentialAccess } from "./credential-access.js";
import type { KeychainBinding } from "./keychain.js";

const { onCleanup } = useCleanups();

/**
 * A start's OS keychain read waiting on the person (#1689): macOS asks them
 * to let a Node binary it does not yet trust read the environment's stored
 * key, and the read blocks until they answer. The watched binding says so
 * once a call has gone `CREDENTIAL_WAIT_AFTER_MS` unanswered, and how it
 * ended once it returns; the reporter tells the launcher, the
 * credential-access record and the service log.
 */

/** A keychain whose calls block until the test settles them, and a timer the test runs by hand. */
const blockingKeychain = () => {
  const held: { readonly resolve: (value: string | undefined) => void; readonly reject: (error: Error) => void }[] = [];
  const block = () => new Promise<string | undefined>((resolve, reject) => held.push({ resolve, reject }));
  const binding: KeychainBinding = { get: block, set: async () => void (await block()), delete: async () => void (await block()) };
  const waits: { readonly ms: number; readonly run: () => void; cancelled: boolean }[] = [];
  const after = (ms: number, run: () => void) => {
    const wait = { ms, run, cancelled: false };
    waits.push(wait);
    return () => void (wait.cancelled = true);
  };
  const runWaits = () => {
    for (const wait of waits.splice(0)) if (!wait.cancelled) wait.run();
  };
  return { binding, held, after, runWaits, pending: () => waits.filter((wait) => !wait.cancelled).map((wait) => wait.ms) };
};

describe("a keychain watched for a read that waits on the person", () => {
  it("says nothing of a call that returns before the OS could be asking", async () => {
    const keychain = blockingKeychain();
    const said: CredentialAccessState[] = [];
    const watched = watchCredentialAccess(keychain.binding, (state) => said.push(state), keychain.after);
    const read = watched.get("agent-harness env-1", "client-session-signing-key");
    expect(keychain.pending()).toEqual([CREDENTIAL_WAIT_AFTER_MS]);
    keychain.held[0]?.resolve("key");
    await expect(read).resolves.toBe("key");
    expect(keychain.pending()).toEqual([]);
    expect(said).toEqual([]);
  });

  it("says waiting once a call goes unanswered, and answered once it returns, with its value", async () => {
    const keychain = blockingKeychain();
    const said: CredentialAccessState[] = [];
    const watched = watchCredentialAccess(keychain.binding, (state) => said.push(state), keychain.after);
    const read = watched.get("agent-harness env-1", "client-session-signing-key");
    keychain.runWaits();
    expect(said).toEqual(["waiting"]);
    keychain.held[0]?.resolve("key");
    await expect(read).resolves.toBe("key");
    expect(said).toEqual(["waiting", "answered"]);
  });

  it("says refused once a call it said was waiting fails, and the failure stays the caller's", async () => {
    const keychain = blockingKeychain();
    const said: CredentialAccessState[] = [];
    const watched = watchCredentialAccess(keychain.binding, (state) => said.push(state), keychain.after);
    const write = watched.set("agent-harness env-1", "client-session-signing-key", "key");
    keychain.runWaits();
    keychain.held[0]?.reject(new Error("User canceled the operation."));
    await expect(write).rejects.toThrow("User canceled the operation.");
    expect(said).toEqual(["waiting", "refused"]);
  });

  it("says waiting once for calls that wait together, and answered once the last of them returns", async () => {
    const keychain = blockingKeychain();
    const said: CredentialAccessState[] = [];
    const watched = watchCredentialAccess(keychain.binding, (state) => said.push(state), keychain.after);
    const first = watched.get("agent-harness env-1", "probe");
    const second = watched.delete("agent-harness env-1", "old");
    keychain.runWaits();
    expect(said).toEqual(["waiting"]);
    keychain.held[0]?.resolve(undefined);
    await first;
    expect(said).toEqual(["waiting"]);
    keychain.held[1]?.resolve(undefined);
    await second;
    expect(said).toEqual(["waiting", "answered"]);
  });
});

describe("where a start says its read waits on the person", () => {
  const dataDirectory = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "ah-credential-access-"));
    onCleanup(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const recordIn = (dataDir: string): unknown => JSON.parse(readFileSync(join(dataDir, CREDENTIAL_ACCESS_FILE), "utf8"));
  const at = new Date("2026-10-06T10:34:01.000Z");

  it("tells the launcher, writes the credential-access record and logs while it waits, and takes the record away once answered", () => {
    const dataDir = dataDirectory();
    const told: CredentialAccessState[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => logged.mockRestore());
    const report = credentialAccessReporter({ dataDir, version: "0.1.3", launcher: { credentialAccess: (state) => told.push(state) }, now: () => at });

    report("waiting");
    expect(recordIn(dataDir)).toEqual({ version: "0.1.3", pid: process.pid, since: at.toISOString(), state: "waiting" });
    expect(logged).toHaveBeenLastCalledWith(
      "The OS is asking to let agent-harness read this environment's stored key, and the start waits for the answer: on macOS, answer “Always Allow” in its dialog.",
    );
    report("answered");
    expect(existsSync(join(dataDir, CREDENTIAL_ACCESS_FILE))).toBe(false);
    expect(told).toEqual(["waiting", "answered"]);
  });

  it("keeps the record, marked refused, once the person refused, for the window to explain", () => {
    const dataDir = dataDirectory();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => logged.mockRestore());
    const report = credentialAccessReporter({ dataDir, version: "0.1.3", launcher: {}, now: () => at });
    report("waiting");
    report("refused");
    expect(recordIn(dataDir)).toEqual({ version: "0.1.3", pid: process.pid, since: at.toISOString(), state: "refused" });
    expect(logged).toHaveBeenLastCalledWith("The OS refused to let agent-harness read this environment's stored key.");
  });

  it("clears the record an earlier start left, which the launcher ended while it waited", () => {
    const dataDir = dataDirectory();
    writeFileSync(join(dataDir, CREDENTIAL_ACCESS_FILE), JSON.stringify({ version: "0.1.3", pid: 4242, since: at.toISOString(), state: "waiting" }));
    clearCredentialAccess(dataDir);
    expect(existsSync(join(dataDir, CREDENTIAL_ACCESS_FILE))).toBe(false);
    expect(() => clearCredentialAccess(dataDir)).not.toThrow();
  });
});
