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
  /** Every OS operation by item, since the store reuses an opened item. */
  const asked: string[] = [];
  const open = (name: string): MacCredentials => {
    opened.push(name);
    const storage = items.get(name) ?? fakeElectron({ os: "darwin" }).safeStorage;
    items.set(name, storage);
    const access = () => {
      asked.push(name);
      if (refuseOriginal && name === "agent-harness") throw new Error("The earlier OS item needs approval");
    };
    return {
      available: async () => { access(); return storage.isAsyncEncryptionAvailable(); },
      encrypt: async (value) => { access(); return storage.encryptStringAsync(value); },
      decrypt: async (value) => { access(); return (await storage.decryptStringAsync(value)).result; },
      close: () => {},
    };
  };
  return { open, opened, asked };
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


it.each([true, false])("pairs into fresh storage after replacement beside an unreadable and unwritable item, with probe refusal=%s", async (refuseProbe) => {
  const dir = join(scratch(), "secrets");
  const os = keychains(false);
  const signal = new AbortController().signal;
  const prior = macCredentialStore({ dir, open: os.open });
  const kept = await prior.encrypt("credential-for-tests-prior-build", signal);
  prior.close();
  const previousItems = new Set(os.opened);
  const attempted: string[] = [];
  const replaced = macCredentialStore({ dir, open: name => {
    const item = os.open(name);
    const check = () => {
      attempted.push(name);
      if (previousItems.has(name)) throw new Error("The previous build owns this unreadable and unwritable item");
    };
    return {
      ...item,
      available: async signal => { if (refuseProbe) check(); return item.available(signal); },
      encrypt: async (secret, signal) => { check(); return item.encrypt(secret, signal); },
      decrypt: async (bytes, signal) => { check(); return item.decrypt(bytes, signal); },
    };
  } });
  // Your machines and pairing probe before spending the one-use code; neither may touch the old item.
  expect(await replaced.available(signal)).toBe(true);
  const fresh = await replaced.encrypt("credential-for-tests-new-pairing", signal);
  expect(attempted.some(name => previousItems.has(name))).toBe(false);
  await expect(replaced.decrypt(kept, signal)).rejects.toThrow(/previous build owns/);
  await replaced.recover(kept);
  expect(await replaced.decrypt(fresh, signal)).toBe("credential-for-tests-new-pairing");
  replaced.close();
  const relaunched = macCredentialStore({ dir, open: os.open });
  expect(await relaunched.decrypt(fresh, signal)).toBe("credential-for-tests-new-pairing");
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

it("reads retained original ciphertext, but writes and probes only this data folder's own item", async () => {
  const dir = join(scratch(), "secrets");
  const os = keychains(false);
  const store = macCredentialStore({ dir, open: os.open });
  const signal = new AbortController().signal;
  const legacy = fakeElectron({ os: "darwin" }).safeStorage.encryptString("credential-for-tests-kept");
  expect(await store.decrypt(legacy, signal)).toBe("credential-for-tests-kept");
  const asked = os.asked.length;
  expect(await store.available(signal)).toBe(true);
  const fresh = await store.encrypt("credential-for-tests-fresh", signal);
  // The app-wide item may belong to an earlier, differently signed build even in a new data folder.
  expect(os.asked.slice(asked)).not.toContain("agent-harness");
  expect(await store.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  expect(await store.recovery()).toBe(false);
  store.close();
  const relaunched = macCredentialStore({ dir, open: os.open });
  expect(await relaunched.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  expect(await relaunched.encrypt("credential-for-tests-next", signal)).toEqual(expect.any(Buffer));
  expect(new Set(os.asked.slice(asked))).toHaveLength(1);
  relaunched.close();
});

it.each([
  ["a write fails", (store: ReturnType<typeof macCredentialStore>, signal: AbortSignal) => store.encrypt("credential-for-tests-refused", signal)],
  ["availability is refused", async (store: ReturnType<typeof macCredentialStore>, signal: AbortSignal) => {
    if (!(await store.available(signal))) throw new Error("refused");
  }],
])("retires this folder's item when %s, so later writes, probes and relaunches never ask for it again", async (_case, fail) => {
  const dir = join(scratch(), "secrets");
  const os = keychains();
  let refusing: string | undefined;
  const open = (name: string): MacCredentials => {
    refusing ??= name;
    const item = os.open(name);
    if (name !== refusing) return item;
    return { ...item, available: async () => false, encrypt: () => Promise.reject(new Error("The OS item needs approval")) };
  };
  const signal = new AbortController().signal;
  const store = macCredentialStore({ dir, open });
  await expect(fail(store, signal)).rejects.toThrow();
  const fresh = await store.encrypt("credential-for-tests-fresh", signal);
  expect(await store.available(signal)).toBe(true);
  expect(await store.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  // Nothing was kept under the retired item, so there is nothing to pair again.
  expect(await store.recovery()).toBe(false);
  store.close();
  const relaunched = macCredentialStore({ dir, open });
  expect(await relaunched.available(signal)).toBe(true);
  expect(await relaunched.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  relaunched.close();
  expect(os.opened.filter(name => name === refusing)).toHaveLength(1);
  expect(os.opened).not.toContain("agent-harness");
});

it("keeps an item a shutdown cancelled", async () => {
  const dir = join(scratch(), "secrets");
  const os = keychains();
  const signal = new AbortController().signal;
  const prior = macCredentialStore({ dir, open: os.open });
  const kept = await prior.encrypt("credential-for-tests-kept", signal);
  prior.close();
  let entered!: (release: () => void) => void;
  const pending = new Promise<() => void>(resolve => { entered = resolve; });
  const open = (name: string): MacCredentials => ({
    ...os.open(name),
    encrypt: () => new Promise((_resolve, reject) => entered(() => reject(new Error("Desktop credential access was cancelled at shutdown.")))),
  });
  const store = macCredentialStore({ dir, open });
  expect(await store.decrypt(kept, signal)).toBe("credential-for-tests-kept");
  const writing = store.encrypt("credential-for-tests-cancelled", signal);
  const release = await pending;
  store.close();
  release();
  await expect(writing).rejects.toThrow(/shutdown/);
  const relaunched = macCredentialStore({ dir, open: os.open });
  expect(await relaunched.decrypt(kept, signal)).toBe("credential-for-tests-kept");
  const fresh = await relaunched.encrypt("credential-for-tests-fresh", signal);
  expect(await relaunched.decrypt(fresh, signal)).toBe("credential-for-tests-fresh");
  relaunched.close();
  expect(new Set(os.opened)).toHaveLength(1);
});
