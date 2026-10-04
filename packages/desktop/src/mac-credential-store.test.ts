import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, scratch } from "../test/harness.js";
import type { MacCredentials } from "./mac-credentials.js";
import { macCredentialStore } from "./mac-credential-store.js";

afterEach(cleanUp);

/** Keychain is the external boundary: only the older service refuses the new code identity. */
const keychains = (refuseOriginal = true) => {
  const items = new Map<string, ReturnType<typeof fakeElectron>["safeStorage"]>();
  const opened: string[] = [];
  const open = (name: string): MacCredentials => {
    opened.push(name);
    const storage = items.get(name) ?? fakeElectron({ os: "darwin" }).safeStorage;
    items.set(name, storage);
    const access = () => { if (refuseOriginal && name === "agent-harness") throw new Error("The earlier OS item needs approval"); };
    return {
      available: async () => { access(); return storage.isAsyncEncryptionAvailable(); },
      encrypt: async (value) => { access(); return storage.encryptStringAsync(value); },
      decrypt: async (value) => { access(); return (await storage.decryptStringAsync(value)).result; },
      close: () => {},
    };
  };
  return { open, opened };
};

it("recovers from the earlier OS item into fresh protected storage that a relaunch can read", async () => {
  const dir = join(scratch(), "secrets");
  mkdirSync(dir);
  const os = keychains();
  const old = fakeElectron({ os: "darwin" }).safeStorage.encryptString("credential-for-tests-kept");
  const store = macCredentialStore({ dir, open: os.open });
  const signal = new AbortController().signal;
  await expect(store.decrypt(old, signal)).rejects.toThrow(/needs approval/);
  await store.recover(old);
  expect(await store.available(signal)).toBe(true);
  const fresh = await store.encrypt("credential-for-tests-fresh", signal);
  expect(fresh.includes(Buffer.from("credential-for-tests-fresh"))).toBe(false);
  expect(await store.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  store.close();
  const relaunched = macCredentialStore({ dir, open: os.open });
  expect(await relaunched.available(signal)).toBe(true);
  expect(await relaunched.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  expect(os.opened.filter(name => name === "agent-harness")).toHaveLength(1);
  relaunched.close();
});


it("keeps recovery visible across relaunch and fresh successes until the earlier credential is replaced", async () => {
  const dir = join(scratch(), "secrets");
  mkdirSync(dir);
  const os = keychains();
  const old = fakeElectron({ os: "darwin" }).safeStorage.encryptString("credential-for-tests-kept");
  const file = join(dir, "desk.secret");
  writeFileSync(file, old);
  const signal = new AbortController().signal;
  const store = macCredentialStore({ dir, open: os.open });
  await store.recover(old);
  const fresh = await store.encrypt("credential-for-tests-fresh", signal);
  expect(await store.recovery()).toBe(true);
  expect(readFileSync(file)).toEqual(old);
  store.close();
  const relaunched = macCredentialStore({ dir, open: os.open });
  expect(await relaunched.recovery()).toBe(true);
  await expect(relaunched.decrypt(old, signal)).rejects.toThrow(/unavailable/);
  expect(await relaunched.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  expect(os.opened).not.toContain("agent-harness");
  writeFileSync(file, fresh);
  expect(await relaunched.recovery()).toBe(false);
  rmSync(file);
  expect(await relaunched.recovery()).toBe(false);
  relaunched.close();
});

it("persists concurrent failures in different earlier items without losing either recovery", async () => {
  const dir = join(scratch(), "secrets");
  mkdirSync(dir);
  const os = keychains();
  const signal = new AbortController().signal;
  const store = macCredentialStore({ dir, open: os.open });
  const old = fakeElectron({ os: "darwin" }).safeStorage.encryptString("credential-for-tests-kept");
  await store.recover(old);
  const earlier = await store.encrypt("credential-for-tests-earlier", signal);
  await store.recover(earlier);
  const recent = await store.encrypt("credential-for-tests-recent", signal);
  store.close();
  const otherDir = join(scratch(), "secrets");
  mkdirSync(otherDir);
  const other = macCredentialStore({ dir: otherDir, open: os.open });
  await other.recover(old);
  const independent = await other.encrypt("credential-for-tests-independent", signal);
  other.close();
  // Independently kept credentials can fail in the same turn, as connection startup does.
  const next = macCredentialStore({ dir, open: os.open });
  await Promise.all([next.recover(recent), next.recover(independent)]);
  const fresh = await next.encrypt("credential-for-tests-fresh", signal);
  next.close();
  const restarted = macCredentialStore({ dir, open: os.open });
  await expect(restarted.decrypt(recent, signal)).rejects.toThrow(/unavailable/);
  await expect(restarted.decrypt(independent, signal)).rejects.toThrow(/unavailable/);
  expect(await restarted.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  restarted.close();
});

it("keeps the original ciphertext format when retained access still works", async () => {
  const dir = join(scratch(), "secrets");
  const os = keychains(false);
  const store = macCredentialStore({ dir, open: os.open });
  const signal = new AbortController().signal;
  const legacy = fakeElectron({ os: "darwin" }).safeStorage.encryptString("credential-for-tests-kept");
  expect(await store.decrypt(legacy, signal)).toBe("credential-for-tests-kept");
  const kept = await store.encrypt("credential-for-tests-fresh", signal);
  // An earlier build's OS provider can still consume an ordinary retained-item write.
  expect(await os.open("agent-harness").decrypt(kept, signal)).toBe("credential-for-tests-fresh");
  expect(await store.recovery()).toBe(false);
  store.close();
});
