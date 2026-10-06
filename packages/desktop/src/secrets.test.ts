import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, CredentialAccessUnansweredError, isCredentialAccessUnanswered, StoredCredentialUnavailableError, type HttpFetch } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock } from "@agent-harness/client-runtime/testing";
import { fakeWire, flush } from "@agent-harness/client-runtime/testing/fake-wire";
import { keychainSecrets } from "./secrets.js";
import { macCredentialStore } from "./mac-credential-store.js";
import type { MacCredentials } from "./mac-credentials.js";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";

afterEach(cleanUp);

/**
 * The shell's `secrets` (docs/specs/gui.md, "The desktop shell"): the client
 * session tokens the runtime keeps by environment id, one file each in the
 * desktop's data directory, encrypted by Electron's `safeStorage` under the
 * key the OS keeps for the app.
 */

const DESK = "0199aa00-0000-7000-8000-00000000d35c";
const LAPTOP = "0199aa00-0000-7000-8000-0000000019a7";

describe("secrets", () => {
  it("keeps unreadable earlier ciphertext while fresh credentials work and the recovery notice stays visible", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const platform = platformOn("darwin");
    const dir = join(platform.paths.data, "secrets");
    mkdirSync(dir);
    const file = join(dir, `${DESK}.secret`);
    const kept = electron.safeStorage.encryptString("token-for-tests-kept");
    writeFileSync(file, kept);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let approve!: (value: string) => void;
    const services = new Map<string, ReturnType<typeof fakeElectron>["safeStorage"]>();
    const open = (name: string): MacCredentials => {
      const storage = services.get(name) ?? fakeElectron({ os: "darwin" }).safeStorage;
      services.set(name, storage);
      return {
        available: async () => { if (name === "agent-harness") throw new Error("The earlier OS item needs approval"); return true; },
        encrypt: (value) => storage.encryptStringAsync(value),
        decrypt: name === "agent-harness" ? () => new Promise((resolve) => { approve = resolve; entered(); }) : async (value) => (await storage.decryptStringAsync(value)).result,
        close: () => {},
      };
    };
    const clock = manualClock();
    const macCredentials = macCredentialStore({ dir, open });
    const { shell } = await start({ electron, platform, credentialClock: clock, macCredentials, reportError: () => {} });
    const secrets = shell().secrets;
    const refused = expect(secrets.get(DESK)).rejects.toThrow(/previous build could not be read/);
    await started;
    expect(await shell().system()).toMatchObject({ platform: "darwin" });
    clock.advance(30_000);
    await refused;
    expect(readFileSync(file)).toEqual(kept);
    await secrets.set(LAPTOP, "token-for-tests-fresh");
    expect(await secrets.get(LAPTOP)).toBe("token-for-tests-fresh");
    expect(await secrets.protection()).toBe("os");
    expect(await secrets.access()).toBe("denied");
    approve("token-for-tests-kept");
    await flush();
    expect(await secrets.access()).toBe("denied");
    expect(readFileSync(file)).toEqual(kept);
    await secrets.set(DESK, "token-for-tests-paired-again");
    expect(await secrets.get(DESK)).toBe("token-for-tests-paired-again");
    expect(await secrets.access()).toBeNull();
    electron.app.quit();
    await electron.app.quitted;
  });

  it("keeps a lone malformed envelope repairable across fresh writes and relaunch without prior recovery metadata", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const dir = join(platformOn("darwin").paths.data, "secrets");
    mkdirSync(dir);
    const file = join(dir, `${DESK}.secret`);
    const damaged = Buffer.from("ah-mac-credential-v1\nagent-harness credentials truncated");
    writeFileSync(file, damaged);
    const open = (): MacCredentials => ({
      available: async () => true,
      encrypt: (value) => electron.safeStorage.encryptStringAsync(value),
      decrypt: async (value) => (await electron.safeStorage.decryptStringAsync(value)).result,
      close: () => {},
    });
    const makeSecrets = () => keychainSecrets({ safeStorage: electron.safeStorage, os: "darwin", dir,
      macCredentials: macCredentialStore({ dir, open }), report: () => {} });
    const secrets = makeSecrets();
    expect(await secrets.access()).toBe("denied");
    await expect(secrets.get(DESK)).rejects.toBeInstanceOf(StoredCredentialUnavailableError);
    await expect(secrets.get(DESK)).rejects.toThrow(/Invalid macOS credential envelope/);
    expect(readFileSync(file)).toEqual(damaged);
    await secrets.set(LAPTOP, "token-for-tests-fresh");
    expect(await secrets.get(LAPTOP)).toBe("token-for-tests-fresh");
    expect(await secrets.protection()).toBe("os");
    await secrets.delete(LAPTOP);
    expect(await secrets.access()).toBe("denied");
    secrets.close();
    const relaunched = makeSecrets();
    expect(await relaunched.access()).toBe("denied");
    await relaunched.set(DESK, "token-for-tests-paired-again");
    expect(await relaunched.get(DESK)).toBe("token-for-tests-paired-again");
    expect(await relaunched.access()).toBeNull();
    relaunched.close();
  });

  it("isolates a damaged envelope while other credentials can be repaired, written and deleted", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const dir = join(platformOn("darwin").paths.data, "secrets");
    mkdirSync(dir);
    const original = electron.safeStorage.encryptString("token-for-tests-kept");
    writeFileSync(join(dir, `${DESK}.secret`), original);
    const damagedId = "0199aa00-0000-7000-8000-000000000bad";
    const damaged = Buffer.from("ah-mac-credential-v1\nagent-harness credentials truncated");
    const damagedFile = join(dir, `${damagedId}.secret`);
    writeFileSync(damagedFile, damaged);
    const items = new Map<string, ReturnType<typeof fakeElectron>["safeStorage"]>();
    const macCredentials = macCredentialStore({ dir, open: (name) => {
      const storage = items.get(name) ?? fakeElectron({ os: "darwin" }).safeStorage;
      items.set(name, storage);
      return {
        available: async () => true,
        encrypt: (value) => storage.encryptStringAsync(value),
        decrypt: async (value) => {
          if (name === "agent-harness") throw new Error("The earlier OS item needs approval");
          return (await storage.decryptStringAsync(value)).result;
        },
        close: () => {},
      };
    } });
    const secrets = keychainSecrets({ safeStorage: electron.safeStorage, os: "darwin", dir, macCredentials, report: () => {} });
    await expect(secrets.get(DESK)).rejects.toThrow(/previous build could not be read/);
    // Local adoption deletes its former token before using an administrative grant.
    await secrets.delete(DESK);
    await secrets.set(LAPTOP, "token-for-tests-fresh");
    expect(await secrets.get(LAPTOP)).toBe("token-for-tests-fresh");
    expect(await secrets.protection()).toBe("os");
    await secrets.delete(LAPTOP);
    expect(await secrets.get(LAPTOP)).toBeUndefined();
    expect(await secrets.access()).toBe("denied");
    await expect(secrets.get(damagedId)).rejects.toThrow(/Invalid macOS credential envelope/);
    expect(readFileSync(damagedFile)).toEqual(damaged);
    macCredentials.close();
  });

  it("bounds an unanswered macOS read, preserves its ciphertext, and ignores late approval before retry", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const platform = platformOn("darwin");
    const dir = join(platform.paths.data, "secrets");
    mkdirSync(dir);
    const file = join(dir, `${DESK}.secret`);
    const kept = electron.safeStorage.encryptString("token-for-tests-desk");
    writeFileSync(file, kept);
    const decrypt = electron.safeStorage.decryptStringAsync;
    let approve!: (answer: { result: string; shouldReEncrypt: boolean }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    electron.safeStorage.decryptStringAsync = () => new Promise((resolve) => { approve = resolve; entered(); });
    const clock = manualClock();
    const secrets = keychainSecrets({ safeStorage: electron.safeStorage, os: "darwin", dir, report: () => {}, clock });
    let outcome = "pending";
    const reading = secrets.get(DESK).then(() => { outcome = "read"; }, () => { outcome = "unavailable"; });
    await started;
    clock.advance(30_000);
    await flush();
    expect(outcome).toBe("unavailable");
    await reading;
    expect(await secrets.access()).toBe("denied");
    approve({ result: "token-for-tests-desk", shouldReEncrypt: false });
    await flush();
    expect(await secrets.access()).toBe("denied");
    expect(readFileSync(file)).toEqual(kept);
    electron.safeStorage.decryptStringAsync = decrypt;
    expect(await secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(await secrets.access()).toBeNull();
  });

  it.each(["availability", "encryption"])("bounds pending %s during pairing without overwriting the prior credential", async (stage) => {
    const electron = fakeElectron({ os: "darwin" });
    const platform = platformOn("darwin");
    const dir = join(platform.paths.data, "secrets");
    const clock = manualClock();
    const secrets = keychainSecrets({ safeStorage: electron.safeStorage, os: "darwin", dir, report: () => {}, clock });
    await secrets.set(DESK, "token-for-tests-desk");
    const file = join(dir, `${DESK}.secret`);
    const kept = readFileSync(file);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let approve!: () => void;
    if (stage === "availability") electron.safeStorage.isAsyncEncryptionAvailable = () => new Promise((resolve) => { approve = () => resolve(true); entered(); });
    else electron.safeStorage.encryptStringAsync = () => new Promise((resolve) => { approve = () => resolve(Buffer.from("late-ciphertext-for-tests")); entered(); });
    let outcome = "pending";
    const pairing = secrets.set(DESK, "token-for-tests-replacement").then(() => { outcome = "stored"; }, () => { outcome = "unavailable"; });
    await started;
    clock.advance(30_000);
    await flush();
    expect(outcome).toBe("unavailable");
    await pairing;
    approve();
    await flush();
    expect(readFileSync(file)).toEqual(kept);
    expect(readdirSync(dir)).toEqual([`${DESK}.secret`]);
    secrets.close();
  });

  it.each(["the helper's store", "Electron's provider"])("leaves the earlier-build warning off when a fresh install's availability check or write goes unanswered or refused, through %s", async (through) => {
    const electron = fakeElectron({ os: "darwin" });
    const dir = join(platformOn("darwin").paths.data, "secrets");
    const clock = manualClock();
    let entered!: () => void;
    let started = new Promise<void>((resolve) => { entered = resolve; });
    let refuse = false;
    const unanswered = <T>(): Promise<T> => { entered(); return new Promise<T>(() => undefined); };
    const available = (): Promise<boolean> => (refuse ? Promise.resolve(false) : unanswered());
    const helper: MacCredentials = {
      available,
      encrypt: () => unanswered(),
      decrypt: () => unanswered(),
      close: () => {},
    };
    electron.safeStorage.isAsyncEncryptionAvailable = available;
    electron.safeStorage.encryptStringAsync = () => unanswered();
    const macCredentials = through === "the helper's store" ? macCredentialStore({ dir, open: () => helper }) : undefined;
    const secrets = keychainSecrets({ safeStorage: electron.safeStorage, os: "darwin", dir, report: () => {}, clock, ...(macCredentials && { macCredentials }) });
    const published: unknown[] = [];
    secrets.onAccess((state) => published.push(state));
    const expire = async (request: Promise<unknown>) => {
      const settled = request.catch((error: unknown) => error);
      await started;
      started = new Promise<void>((resolve) => { entered = resolve; });
      clock.advance(30_000);
      return settled;
    };
    expect(await expire(secrets.protection())).toBeInstanceOf(CredentialAccessUnansweredError);
    expect(await expire(secrets.set(DESK, "token-for-tests-desk"))).toBeInstanceOf(CredentialAccessUnansweredError);
    refuse = true;
    await expect(secrets.set(DESK, "token-for-tests-desk")).rejects.toThrow(/unlock or set up the system keychain/);
    await flush();
    expect(published).toContain("waiting");
    expect(published).not.toContain("denied");
    expect(await secrets.access()).toBeNull();
    secrets.close();
  });

  it("bounds protection queries during provider initialization and cancels pending calls at desktop shutdown", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const clock = manualClock();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    electron.safeStorage.isAsyncEncryptionAvailable = () => { entered(); return new Promise(() => {}); };
    const { shell } = await start({ electron, platform: platformOn("darwin"), credentialClock: clock, reportError: () => {} });
    const secrets = shell().secrets;
    let outcome = "pending";
    const protecting = secrets.protection().then(() => { outcome = "protected"; }, () => { outcome = "unavailable"; });
    await started;
    clock.advance(30_000);
    await flush();
    expect(outcome).toBe("unavailable");
    await protecting;
    const storing = expect(secrets.set(DESK, "token-for-tests")).rejects.toThrow(/shutdown/);
    electron.app.quit();
    await electron.app.quitted;
    await storing;
    await expect(secrets.set(DESK, "token-for-tests")).rejects.toThrow(/shutdown/);
  });

  it("reads a prior macOS install's credential without accessing Keychain on the main thread", async () => {
    const platform = platformOn("darwin");
    const electron = fakeElectron({ os: "darwin" });
    const folder = join(platform.paths.data, "secrets");
    mkdirSync(folder);
    writeFileSync(join(folder, `${DESK}.secret`), electron.safeStorage.encryptString("token-for-tests-desk"));
    const synchronousAccess = () => { throw new Error("Keychain access would block the main thread"); };
    electron.safeStorage.isEncryptionAvailable = synchronousAccess;
    electron.safeStorage.encryptString = synchronousAccess;
    electron.safeStorage.decryptString = synchronousAccess;
    const { shell } = await start({ electron, platform, reportError: () => {} });

    expect(await shell().secrets.get(DESK)).toBe("token-for-tests-desk");
    await shell().secrets.set(LAPTOP, "token-for-tests-laptop");
    expect(await shell().secrets.get(LAPTOP)).toBe("token-for-tests-laptop");
    expect(await shell().secrets.protection()).toBe("os");
  });

  it("keeps the window usable while macOS approval is pending or cancelled, and preserves the prior credential", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const platform = platformOn("darwin");
    const folder = join(platform.paths.data, "secrets");
    mkdirSync(folder);
    const kept = electron.safeStorage.encryptString("token-for-tests-desk");
    writeFileSync(join(folder, `${DESK}.secret`), kept);
    const decrypt = electron.safeStorage.decryptStringAsync;
    let cancel!: (error: Error) => void;
    electron.safeStorage.decryptStringAsync = () => new Promise((_resolve, reject) => { cancel = reject; });
    const reported: unknown[] = [];
    const { shell } = await start({ electron, platform, reportError: (error) => reported.push(error) });
    const bridge = shell();
    const waiting = new Promise<void>((resolve) => bridge.secrets.onAccess((state) => { if (state === "waiting") resolve(); }));
    const reading = bridge.secrets.get(DESK);
    await waiting;
    expect(await bridge.secrets.access()).toBe("waiting");
    expect(await bridge.system()).toMatchObject({ platform: "darwin" });
    expect(await bridge.window.state?.()).toMatchObject({ platform: "darwin" });
    cancel(new Error("OS approval cancelled"));
    await expect(reading).rejects.toThrow(/cancelled/);
    expect(await bridge.secrets.access()).toBe("denied");
    expect(await bridge.secrets.protection()).toBe("os");
    expect(await bridge.secrets.access()).toBe("denied");
    expect(readFileSync(join(folder, `${DESK}.secret`))).toEqual(kept);
    electron.safeStorage.decryptStringAsync = decrypt;
    expect(await bridge.secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(await bridge.secrets.access()).toBeNull();
    expect(reported.map(String)).toEqual([expect.stringMatching(/cancelled.*kept/i)]);
  });

  it("settles access after a successful read that overlapped a refused read", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const platform = platformOn("darwin");
    const folder = join(platform.paths.data, "secrets");
    mkdirSync(folder);
    const desk = electron.safeStorage.encryptString("token-for-tests-desk");
    writeFileSync(join(folder, `${DESK}.secret`), desk);
    writeFileSync(join(folder, `${LAPTOP}.secret`), electron.safeStorage.encryptString("token-for-tests-laptop"));
    const decrypt = electron.safeStorage.decryptStringAsync;
    let rejectFirst!: (error: Error) => void;
    let allowSecond!: () => void;
    let bothEntered!: () => void;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const second = new Promise<void>((resolve) => { allowSecond = resolve; });
    const entered = new Promise<void>((resolve) => { bothEntered = resolve; });
    let pending = 0;
    electron.safeStorage.decryptStringAsync = async (kept) => {
      if (++pending === 2) bothEntered();
      await (kept.equals(desk) ? first : second);
      return decrypt(kept);
    };
    const { shell } = await start({ electron, platform, reportError: () => {} });
    const secrets = shell().secrets;
    const refused = expect(secrets.get(DESK)).rejects.toThrow(/cancelled/);
    const allowed = secrets.get(LAPTOP);
    await entered;
    rejectFirst(new Error("OS approval cancelled"));
    await refused;
    expect(await secrets.access()).toBe("waiting");
    allowSecond();
    expect(await allowed).toBe("token-for-tests-laptop");
    expect(await secrets.access()).toBeNull();
  });

  it("preserves a paired credential and recovers after never-settling Keychain access during reconnection", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const platform = platformOn("darwin");
    const clock = manualClock();
    const credentialClock = manualClock();
    const { shell } = await start({ electron, platform, credentialClock, reportError: () => {} });
    const secrets = shell().secrets;
    const wire = fakeWire({ clock });
    const runtime = createRuntime(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, secrets }));
    try {
      await runtime.start();
      const adding = runtime.connections.add({ link: wire.link });
      await wire.server.accept();
      expect(await adding).toMatchObject({ status: "paired" });
      const file = join(platform.paths.data, "secrets", `${wire.environmentId}.secret`);
      const kept = readFileSync(file);
      const decrypt = electron.safeStorage.decryptStringAsync;
      let cancel!: (error: Error) => void;
      electron.safeStorage.decryptStringAsync = () => new Promise((_resolve, reject) => { cancel = reject; });
      const waiting = new Promise<void>((resolve) => secrets.onAccess((state) => { if (state === "waiting") resolve(); }));
      wire.server.drop();
      await flush();
      const reconnecting = runtime.connections.retryNow(wire.environmentId);
      await waiting;
      credentialClock.advance(30_000);
      await reconnecting;
      cancel(new Error("late OS refusal"));
      await flush();
      expect(runtime.connections.list.read()).toEqual([expect.objectContaining({ phase: "blocked", blocked: "credential-unavailable" })]);
      expect(runtime.projections.notices.read()).toContainEqual(expect.objectContaining({ kind: "credential-unavailable", action: "re-pair" }));
      expect(await secrets.access()).toBe("denied");
      expect(readFileSync(file)).toEqual(kept);
      expect(runtime.projections.notices.read()).not.toContainEqual(expect.objectContaining({ kind: "revoked" }));
      electron.safeStorage.decryptStringAsync = decrypt;
      const retrying = runtime.connections.retryNow(wire.environmentId);
      await wire.server.accept();
      await retrying;
      expect(runtime.connections.list.read()).toEqual([expect.objectContaining({ phase: "ready", blocked: null })]);
      expect(readFileSync(file)).toEqual(kept);
    } finally {
      await runtime.close();
    }
  });

  it("asks macOS before a one-use code is spent, so an unanswered Keychain prompt leaves the code to try again, said in the desktop's own words", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const credentialClock = manualClock();
    // A helper whose OS request no one answers, until the test lets it.
    let answering = false;
    const silent = <T>(answer: () => Promise<T>): Promise<T> => (answering ? answer() : new Promise<T>(() => undefined));
    const macCredentials: MacCredentials = {
      available: () => silent(async () => true),
      encrypt: (value) => silent(() => electron.safeStorage.encryptStringAsync(value)),
      decrypt: (kept) => silent(async () => (await electron.safeStorage.decryptStringAsync(kept)).result),
      close: () => {},
    };
    const { shell } = await start({ electron, platform: platformOn("darwin"), credentialClock, macCredentials, reportError: () => {} });
    const secrets = shell().secrets;
    const waitingFor = <T>(started: () => Promise<T>): Promise<unknown> => {
      const waiting = new Promise<void>((resolve) => { const stop = secrets.onAccess((state) => { if (state === "waiting") { resolve(); queueMicrotask(stop); } }); });
      const settled = started().catch((error: unknown) => error);
      return waiting.then(() => { credentialClock.advance(30_000); return settled; });
    };

    const write = await waitingFor(() => secrets.set(DESK, "token-for-tests-desk"));
    expect(write).toBeInstanceOf(Error);
    expect((write as Error).message).toBe(new CredentialAccessUnansweredError(30).message);

    const clock = manualClock();
    const wire = fakeWire({ clock });
    // The environment's one-use code: a second exchange is refused, as an environment refuses it.
    let exchanges = 0;
    const fetch: HttpFetch = async (url, request) =>
      url.endsWith("/api/pair") && request?.method === "POST" && ++exchanges > 1 ? { status: 410, json: async () => ({ code: "pairing_used" }) } : wire.fetch(url, request);
    const runtime = createRuntime(inMemoryPlatform({ clock, fetch, webSocket: wire.webSocket, secrets }));
    try {
      await runtime.start();
      const unanswered = await waitingFor(() => runtime.connections.add({ link: wire.link }));
      expect(isCredentialAccessUnanswered(unanswered)).toBe(true);
      expect((unanswered as Error).message).not.toMatch(/Error invoking remote method/);
      expect(exchanges).toBe(0);

      answering = true;
      const retried = runtime.connections.add({ link: wire.link });
      await wire.server.accept();
      expect(await retried).toMatchObject({ status: "paired", environmentId: wire.environmentId });
      expect(exchanges).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("keeps each token in a file of its own, encrypted, which a later launch reads back", async () => {
    const platform = platformOn("linux");
    const first = await start({ platform });
    await first.shell().secrets.set(DESK, "token-for-tests-desk");
    await first.shell().secrets.set(LAPTOP, "token-for-tests-laptop");

    const folder = join(platform.paths.data, "secrets");
    expect(readdirSync(folder).sort()).toEqual([`${LAPTOP}.secret`, `${DESK}.secret`].sort());
    const kept = readFileSync(join(folder, `${DESK}.secret`));
    expect(kept.toString("latin1")).toMatch(/^v11/);
    expect(kept.toString("utf8")).not.toContain("token-for-tests");
    expect(statSync(join(folder, `${DESK}.secret`)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);

    const next = await start({ platform });
    expect(await next.shell().secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(await next.shell().secrets.get(LAPTOP)).toBe("token-for-tests-laptop");
  });

  it("replaces a token, forgets one without touching another, and answers none for one it never kept", async () => {
    const { shell } = await start();
    await shell().secrets.set(DESK, "token-for-tests-1");
    await shell().secrets.set(DESK, "token-for-tests-2");
    await shell().secrets.set(LAPTOP, "token-for-tests-laptop");
    await shell().secrets.delete(DESK);
    await shell().secrets.delete(DESK);

    expect(await shell().secrets.get(DESK)).toBeUndefined();
    expect(await shell().secrets.get(LAPTOP)).toBe("token-for-tests-laptop");
    expect(await shell().secrets.get("0199aa00-0000-7000-8000-000000000000")).toBeUndefined();
  });

  it("keeps a name that is not a plain file name inside its folder", async () => {
    const platform = platformOn("linux");
    const { shell } = await start({ platform });
    await shell().secrets.set("../escaped", "token-for-tests");
    expect(readdirSync(platform.paths.data)).not.toContain("escaped.secret");
    expect(await shell().secrets.get("../escaped")).toBe("token-for-tests");
  });

  it("on Linux with no secret service, keeps tokens under Chromium's fixed key, and says once that they are stored unprotected", async () => {
    const electron = fakeElectron({ os: "linux" });
    electron.safeStorage.backend = "basic_text";
    const reported: unknown[] = [];
    const platform = platformOn("linux");
    const { shell } = await start({ electron, platform, reportError: (error) => reported.push(error) });

    await shell().secrets.set(DESK, "token-for-tests-desk");
    await shell().secrets.set(LAPTOP, "token-for-tests-laptop");
    expect(await shell().secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(electron.safeStorage.plainText).toBe(true);
    expect(readFileSync(join(platform.paths.data, "secrets", `${DESK}.secret`)).toString("latin1")).toMatch(/^v10/);
    expect(reported.map(String)).toEqual([expect.stringMatching(/no secret service.*unprotected/i)]);
    // The renderer is told too, for the Your machines card (#416).
    expect(await shell().secrets.protection()).toBe("unprotected");
  });

  it("tells the renderer the key is the OS's where a secret service answers, and unprotected before any token was kept where none does", async () => {
    expect(await (await start({ platform: platformOn("linux") })).shell().secrets.protection()).toBe("os");

    const electron = fakeElectron({ os: "linux" });
    electron.safeStorage.backend = "basic_text";
    const reported: unknown[] = [];
    const { shell } = await start({ electron, platform: platformOn("linux"), reportError: (error) => reported.push(error) });
    expect(await shell().secrets.protection()).toBe("unprotected");
    await shell().secrets.set(DESK, "token-for-tests-desk");
    expect(await shell().secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(reported.map(String)).toEqual([expect.stringMatching(/no secret service.*unprotected/i)]);
  });

  it("refuses unavailable macOS storage without treating a saved credential as absent", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const reported: unknown[] = [];
    const platform = platformOn("darwin");
    const { shell } = await start({ electron, platform, reportError: (error) => reported.push(error) });
    await shell().secrets.set(DESK, "token-for-tests-desk");

    expect(await shell().secrets.protection()).toBe("os");

    electron.safeStorage.keychain = false;
    expect(await shell().secrets.protection()).toBe("none");
    await expect(shell().secrets.set(LAPTOP, "token-for-tests-laptop")).rejects.toThrow(/cannot keep a client session token/);
    expect(readdirSync(join(platform.paths.data, "secrets"))).toEqual([`${DESK}.secret`]);
    await expect(shell().secrets.get(DESK)).rejects.toThrow();

    electron.safeStorage.keychain = true;
    electron.safeStorage.changeKey();
    await expect(shell().secrets.get(DESK)).rejects.toThrow();
    expect(reported.map(String)).toEqual([expect.stringMatching(/previous build could not be read/), expect.stringMatching(/previous build could not be read/)]);
  });

  it("answers none for a token file it cannot read at all, saying why", async () => {
    const reported: unknown[] = [];
    const platform = platformOn("linux");
    const { shell } = await start({ platform, reportError: (error) => reported.push(error) });
    mkdirSync(join(platform.paths.data, "secrets", `${DESK}.secret`), { recursive: true });
    expect(await shell().secrets.get(DESK)).toBeUndefined();
    expect(reported.map(String)).toEqual([expect.stringMatching(/cannot read the token kept for 0199aa00.*EISDIR/)]);
  });

  it("refuses a name or a token that is not text", async () => {
    const { shell } = await start();
    const secrets = shell().secrets as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await expect(secrets["set"]?.(7, "token-for-tests")).rejects.toThrow(/name must be text/);
    await expect(secrets["set"]?.(DESK, { token: 1 })).rejects.toThrow(/secret must be text/);
    await expect(secrets["get"]?.("")).rejects.toThrow(/name must not be empty/);
  });
});
