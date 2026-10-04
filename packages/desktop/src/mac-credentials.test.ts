import { expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { macCredentialProcess, serveMacCredentials, type CredentialChild } from "./mac-credentials.js";

const signals = () => {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    on(name: string, listener: (...args: never[]) => void) {
      const kept = listeners.get(name) ?? [];
      kept.push(listener as (...args: unknown[]) => void);
      listeners.set(name, kept);
    },
    emit(name: string, ...args: unknown[]) { for (const listener of listeners.get(name) ?? []) listener(...args); },
  };
};

/** The OS process/IPC boundary is faked; both sides of the provider protocol run. */
const providerHarness = () => {
  const children: { events: ReturnType<typeof signals>; storage: ReturnType<typeof fakeElectron>["safeStorage"]; killed: boolean }[] = [];
  const provider = macCredentialProcess(() => {
    const events = signals();
    const storage = fakeElectron({ os: "darwin" }).safeStorage;
    const child = { events, storage, killed: false };
    children.push(child);
    serveMacCredentials(storage, Promise.resolve(), (receive) => events.on("request", receive), (reply) => events.emit("message", reply));
    return Object.assign(events, {
      send: (request: unknown) => { events.emit("request", request); return true; },
      kill: () => { child.killed = true; return true; },
    }) as CredentialChild;
  });
  return { provider, children };
};

it("discards pending provider initialization on cancellation, ignores its late reply, and retries with fresh OS storage", async () => {
  const { provider, children } = providerHarness();
  const request = new AbortController();
  const reading = provider.available(request.signal);
  let approve!: (value: boolean) => void;
  children[0]!.storage.isAsyncEncryptionAvailable = () => new Promise((resolve) => { approve = resolve; });
  await Promise.resolve();
  const refused = expect(reading).rejects.toThrow(/cancelled/);
  request.abort();
  await refused;
  expect(children[0]!.killed).toBe(true);
  const retry = new AbortController();
  expect(await provider.available(retry.signal)).toBe(true);
  approve(true);
  const encrypted = await provider.encrypt("token-for-tests", retry.signal);
  expect(encrypted.includes(Buffer.from("token-for-tests"))).toBe(false);
  expect(await provider.decrypt(encrypted, retry.signal)).toBe("token-for-tests");
  expect(children).toHaveLength(2);
  provider.close();
  expect(children.every((child) => child.killed)).toBe(true);
});

it("cancels every caller sharing a provider at shutdown and refuses later calls", async () => {
  const { provider, children } = providerHarness();
  const signal = new AbortController().signal;
  const available = provider.available(signal);
  children[0]!.storage.isAsyncEncryptionAvailable = () => new Promise(() => {});
  const encrypting = provider.encrypt("token-for-tests", signal);
  const answers = [expect(available).rejects.toThrow(/shutdown/), expect(encrypting).rejects.toThrow(/shutdown/)];
  provider.close();
  await Promise.all(answers);
  await expect(provider.available(signal)).rejects.toThrow(/cancelled/);
  expect(children).toHaveLength(1);
});

it("reports refusal without exposing the provider's native error and starts a fresh provider on retry", async () => {
  const { provider, children } = providerHarness();
  const signal = new AbortController().signal;
  const reading = provider.decrypt(Buffer.from("invalid"), signal);
  await expect(reading).rejects.toThrow("macOS Keychain access was refused or unavailable. Allow access and retry.");
  expect(await provider.available(signal)).toBe(true);
  expect(children).toHaveLength(2);
  provider.close();
});
