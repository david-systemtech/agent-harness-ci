import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { buildRelease } from "../packages/cli/scripts/release/build.js";
import { fixtureBuild } from "../packages/cli/test/release-fixtures.js";

const script = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-desktop-update-smoke.mjs")).href;
const { createCdpEvaluator, restartPackagedDesktop, checkPackagedUpdateCleanup, checkQuietPackagedNavigation, checkPackagedCredentialRepair, checkReplacedPackagedCredential, waitForCredentialHelpersExit, quitWithPendingPackagedCredential, startUnavailablePackagedCredential, credentialHelperPids, checkUnavailablePackagedCredential, checkFreshPackagedCredential, askForPackagedUpdate, packagedSettingsOpen, clickPackagedSettings, openPackagedSettings, stampPriorPackagedServer, copyPackagedDesktop, prepareCredentialFixture } = await import(script) as {
  createCdpEvaluator: (peer: {
    send: (frame: string) => void;
    close: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
  }) => { evaluate: (expression: string, stage?: string, milliseconds?: number, options?: { expectDisconnect: boolean }) => Promise<unknown> };
  restartPackagedDesktop: (evaluate: (expression: string) => Promise<unknown>, staged: { path: string; version: string; sha256: string }) => Promise<void>;
  checkPackagedUpdateCleanup: (installed: string, expectedArchive: string) => void;
  checkQuietPackagedNavigation: (evaluate: (expression: string, stage?: string, milliseconds?: number) => Promise<unknown>) => Promise<void>;
  checkPackagedCredentialRepair: (evaluate: (expression: string, stage?: string, milliseconds?: number) => Promise<unknown>) => Promise<void>;
  checkReplacedPackagedCredential: (evaluate: (expression: string, stage?: string, milliseconds?: number) => Promise<unknown>) => Promise<"retained" | "unavailable">;
  waitForCredentialHelpersExit: (helpers: number[], running?: (pid: number) => boolean) => Promise<void>;
  quitWithPendingPackagedCredential: (evaluate: (expression: string) => Promise<unknown>) => Promise<void>;
  startUnavailablePackagedCredential: (evaluate: (expression: string) => Promise<unknown>) => Promise<void>;
  credentialHelperPids: (pid: number, executable: string, run?: (command: string, args: string[]) => string) => number[];
  checkUnavailablePackagedCredential: (evaluate: (expression: string) => Promise<unknown>, observe?: () => Promise<void>) => Promise<void>;
  checkFreshPackagedCredential: (evaluate: (expression: string) => Promise<unknown>) => Promise<void>;
  askForPackagedUpdate: (evaluate: (expression: string) => Promise<unknown>, version: string, outcome?: "retained" | "unavailable") => Promise<void>;
  packagedSettingsOpen: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
  clickPackagedSettings: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
  openPackagedSettings: (evaluate: (expression: string) => Promise<unknown>) => Promise<void>;
  stampPriorPackagedServer: (server: string, version: string) => void;
  copyPackagedDesktop: (source: string, destination: string) => void;
  prepareCredentialFixture: (app: string) => void;
};

/** The smoke's CDP boundary evaluates in a page exposing the preload's shell; no Electron or service manager runs. */
const page = (token: string | undefined, status = 200, fromVersion = "0.0.0-0") => {
  const updates: { address: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const shell = {
    secrets: { get: async (name: string) => { expect(name).toBe("packaged-update-check"); return token; } },
    localGrant: { read: async () => ({ address: { host: "127.0.0.1", port: 4777 } }) },
    installer: { bundledServer: async () => ({ version: "0.2.0", path: "/fixture/app/server" }) },
    system: async () => ({ platform: "darwin" }),
    http: async (address: string, request?: { method: string; headers: Record<string, string>; body: string }) => {
      if (address.endsWith("/api/update")) {
        updates.push({ address, ...request! });
        return { status, json: async () => ({ toVersion: "0.2.0" }) };
      }
      return { status: 200, json: async () => ({ harnessVersion: fromVersion }) };
    },
  };
  const window = { desktopShell: shell };
  const stages: string[] = [];
  const results: unknown[] = [];
  return { updates, stages, results, evaluate: async (expression: string, stage?: string): Promise<unknown> => {
    if (stage) stages.push(stage);
    const result = await runInNewContext(expression, { window }) as unknown;
    results.push(result);
    return result;
  } };
};

describe("the packaged macOS update smoke", () => {
  it("fails on an archive left in staging or its cleanup receipt, before harness cleanup", () => {
    const work = mkdtempSync(join(tmpdir(), "packaged-update-cleanup-"));
    try {
      const installed = join(work, "agent-harness.app");
      const archive = join(installed, "Contents", "Resources", "app.asar");
      mkdirSync(join(installed, "Contents", "Resources"), { recursive: true });
      writeFileSync(archive, "archive-for-tests");
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const temporary = join(work, ".agent-harness.app-update-test");
      mkdirSync(join(temporary, "previous", "Contents", "Resources"), { recursive: true });
      cpSync(archive, join(temporary, "previous", "Contents", "Resources", "app.asar"));
      expect(() => checkPackagedUpdateCleanup(installed, digest)).toThrow(/owned staging directory/);
      rmSync(temporary, { recursive: true });
      writeFileSync(temporary + ".cleanup", installed);
      expect(() => checkPackagedUpdateCleanup(installed, digest)).toThrow(/cleanup receipt/);
      rmSync(temporary + ".cleanup");
      expect(() => checkPackagedUpdateCleanup(installed, digest)).not.toThrow();
      writeFileSync(archive, "wrong-archive-for-tests");
      expect(() => checkPackagedUpdateCleanup(installed, digest)).toThrow(/real app.asar/);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it.each(["reply", "disconnect"])("hands the verified ZIP to Restart to update when CDP delivers %s first", async (first) => {
    const applied: unknown[] = [];
    const staged = { path: "/fixture/replacement.zip", version: "0.2.0", sha256: "digest-for-tests" };
    const peer: Parameters<typeof createCdpEvaluator>[0] = {
      close: () => {},
      send: message => {
        const request = JSON.parse(message) as { id: number; params: { expression: string } };
        const value: unknown = runInNewContext(request.params.expression, {
          window: { desktopShell: { update: { apply: async (...args: unknown[]) => {
            applied.push(args);
            if (first === "disconnect") peer.onclose?.();
            return { outcome: "applied" };
          } } } },
        });
        if (first === "reply") {
          peer.onmessage?.({ data: JSON.stringify({ id: request.id, result: { result: { value } } }) });
          peer.onclose?.();
        }
      },
    };
    await restartPackagedDesktop(createCdpEvaluator(peer).evaluate, staged);
    expect(applied).toEqual([[staged, "now"]]);
  });

  const replacedPage = (unavailable: boolean, message = "Stored credentials from the previous build could not be read", repairWorks = true) => {
    const content = (row: string) => `<section aria-label="Settings"><nav aria-label="Settings rows"><button aria-label="About">About</button></nav><section aria-label="Credential access"><p>macOS is asking for access to the stored credentials. Answering the macOS prompt keeps them.</p><p>${message}. New credentials use a fresh OS-protected item. Pair again with the environments that were paired.</p><button data-repair>Pair again</button></section><section aria-label="${row}"></section></section>`;
    const dom = new JSDOM(content("Your machines"));
    dom.window.document.querySelector('[aria-label="About"]')?.addEventListener("click", () => {
      dom.window.document.body.innerHTML = content("About");
      dom.window.document.querySelector('[data-repair]')?.addEventListener("click", () => {
        if (repairWorks) dom.window.document.body.innerHTML = content("Your machines");
      });
    });
    const p = page("token-for-tests-kept");
    const window = { desktopShell: {
      secrets: { get: async () => { if (unavailable) throw new Error("Stored credentials from the previous build could not be read. Native access deadline."); return "token-for-tests-kept"; }, access: async () => unavailable ? "denied" : null },
      localGrant: { read: async () => ({ secret: "grant-for-tests", address: { host: "127.0.0.1", port: 4777 } }) },
      installer: { bundledServer: async () => ({ version: "0.2.0", path: "/fixture/app/server" }) },
      system: async () => ({ platform: "darwin" }),
      http: async (address: string, request?: { method: string; headers: Record<string, string>; body: string }) => {
        if (address.endsWith("/api/bootstrap")) {
          expect(JSON.parse(request!.body)).toMatchObject({ secret: "grant-for-tests", kind: "tui" });
          return { status: 200, json: async () => ({ token: "token-for-tests-fresh" }) };
        }
        if (address.endsWith("/api/update")) {
          p.updates.push({ address, ...request! });
          return { status: 200, json: async () => ({ toVersion: "0.2.0" }) };
        }
        return { status: 200, json: async () => ({ harnessVersion: "0.0.0-0" }) };
      },
    } };
    return { ...p, document: dom.window.document, evaluate: async (expression: string) => {
      const result = await runInNewContext(expression, { window, document: dom.window.document }) as unknown;
      p.results.push(result);
      return result;
    } };
  };

  it.each([false, true])("proves replacement outcome and upgrades through its retained credential or local recovery, unavailable=%s", async (unavailable) => {
    const p = replacedPage(unavailable);
    const outcome = await checkReplacedPackagedCredential(p.evaluate);
    expect(outcome).toBe(unavailable ? "unavailable" : "retained");
    await askForPackagedUpdate(p.evaluate, "0.2.0", outcome);
    expect(p.updates[0]?.headers.authorization).toBe(unavailable ? "Bearer token-for-tests-fresh" : "Bearer token-for-tests-kept");
    expect(JSON.stringify(p.results)).not.toMatch(/token-for-tests|grant-for-tests/);
  });

  it("fails unavailable recovery when its explanation or repair action is missing", async () => {
    const p = replacedPage(true, "Something went wrong");
    await expect(checkReplacedPackagedCredential(p.evaluate)).rejects.toThrow(/explanation/);
    const actionless = replacedPage(true);
    actionless.document.querySelector("[data-repair]")?.remove();
    await expect(checkReplacedPackagedCredential(actionless.evaluate)).rejects.toThrow(/repair action/);
  });

  it("requires the repair action to navigate from another Settings row, rather than accepting an already-open target", async () => {
    const p = replacedPage(true);
    await checkPackagedCredentialRepair(p.evaluate);
    expect(p.document.querySelector('section[aria-label="Your machines"]')).not.toBeNull();
    vi.useFakeTimers();
    try {
      const broken = replacedPage(true, undefined, false);
      const failed = expect(checkPackagedCredentialRepair(broken.evaluate)).rejects.toThrow(/repair action did not open/);
      await vi.advanceTimersByTimeAsync(5000);
      await failed;
    } finally { vi.useRealTimers(); }
  });

  it("rejects arbitrary read errors and missing pending explanations rather than counting them as recovery", async () => {
    vi.useFakeTimers();
    try {
      for (const pending of [false, true]) {
        const p = replacedPage(false, "Something went wrong");
        p.document.querySelector('[aria-label="Credential access"]')?.remove();
        const window = { desktopShell: {
          secrets: { get: () => pending ? new Promise(() => {}) : Promise.reject(new Error("Unexpected renderer error")), access: async () => pending ? "waiting" : "denied" },
          system: async () => ({ platform: "darwin" }),
        } };
        const evaluate = async (expression: string) => await runInNewContext(expression, { window, document: p.document }) as unknown;
        const failed = expect(checkReplacedPackagedCredential(evaluate)).rejects.toThrow(pending ? /pending macOS access explanation/ : /Only the product's unavailable/);
        await vi.advanceTimersByTimeAsync(1000);
        await failed;
      }
    } finally { vi.useRealTimers(); }
  });

  it("fails a hung prior read at the product deadline while proving main and window responsiveness", async () => {
    vi.useFakeTimers();
    try {
      const p = replacedPage(false);
      // The external OS never answers; the shell still serves independent IPC.
      const window = { desktopShell: { secrets: { get: () => new Promise(() => {}), access: async () => "waiting" }, system: async () => ({ platform: "darwin" }) } };
      let polls = 0;
      const evaluate = async (expression: string, stage?: string) => {
        if (stage?.includes("responsiveness")) polls++;
        return await runInNewContext(expression, { window, document: p.document }) as unknown;
      };
      const failed = expect(checkReplacedPackagedCredential(evaluate)).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(45_000);
      await failed;
      expect(polls).toBeGreaterThan(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(["waiting", "denied"])("refuses to claim pending shutdown when the specific prior read already failed and access is %s", async (access) => {
    let closed = false;
    const window = { desktopShell: {
      secrets: { get: async () => { throw new Error("OS refused"); }, access: async () => access },
      system: async () => ({ platform: "darwin" }), window: { close: () => { closed = true; } },
    } };
    const document = new JSDOM('<section aria-label="Settings"></section>').window.document;
    const evaluate = async (expression: string) => await runInNewContext(expression, { window, document }) as unknown;
    await startUnavailablePackagedCredential(evaluate);
    await expect(quitWithPendingPackagedCredential(evaluate)).rejects.toThrow(/prior credential read is no longer pending/);
    expect(closed).toBe(false);
  });

  it("quits only while the specific prior read is outstanding and access is waiting", async () => {
    let closed = false;
    const window = { desktopShell: {
      secrets: { get: () => new Promise(() => {}), access: async () => "waiting" },
      system: async () => ({ platform: "darwin" }), window: { close: () => { closed = true; } },
    } };
    const document = new JSDOM('<section aria-label="Settings"></section>').window.document;
    const evaluate = async (expression: string) => await runInNewContext(expression, { window, document }) as unknown;
    await startUnavailablePackagedCredential(evaluate);
    await quitWithPendingPackagedCredential(evaluate);
    expect(closed).toBe(true);
  });

  it("accepts the pending-access quit when the page closes before its CDP reply", async () => {
    let closed = false;
    const window = { __packagedCredentialCheck: { settled: false }, desktopShell: {
      secrets: { access: async () => "waiting" },
      window: { close: () => { closed = true; peer.onclose?.(); } },
    } };
    const peer: Parameters<typeof createCdpEvaluator>[0] = {
      close: () => {},
      send: message => {
        const request = JSON.parse(message) as { id: number; params: { expression: string } };
        void Promise.resolve(runInNewContext(request.params.expression, { window })).then(value => {
          // Electron has already destroyed the page: no reply can cross this boundary.
          if (!closed) peer.onmessage?.({ data: JSON.stringify({ id: request.id, result: { result: { value } } }) });
        });
      },
    };
    const cdp = createCdpEvaluator(peer);
    await expect(quitWithPendingPackagedCredential(cdp.evaluate)).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it("requires the captured helper to exit rather than accepting only the desktop's exit", async () => {
    vi.useFakeTimers();
    try {
      let live = true;
      let exited = false;
      const waiting = waitForCredentialHelpersExit([1201], () => live).then(() => { exited = true; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(exited).toBe(false);
      live = false;
      await vi.advanceTimersByTimeAsync(250);
      await waiting;
      expect(exited).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("fails the shutdown check if the captured helper survives or no helper was observed", async () => {
    vi.useFakeTimers();
    try {
      const survived = expect(waitForCredentialHelpersExit([1201], () => true)).rejects.toThrow(/helper did not exit/);
      await vi.advanceTimersByTimeAsync(10_000);
      await survived;
      await expect(waitForCredentialHelpersExit([], () => false)).rejects.toThrow(/helper must be observed/);
    } finally { vi.useRealTimers(); }
  });

  it("captures only the credential helper among the desktop's own child processes, without reading command arguments", () => {
    const calls: [string, string[]][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === "pgrep") return "1201\n1202\n";
      return args.includes("1201") ? "/fixture/agent-harness.app/Contents/MacOS/agent-harness" : "/fixture/agent-harness.app/Contents/Frameworks/agent-harness Helper (Renderer).app/Contents/MacOS/agent-harness Helper (Renderer)";
    };
    expect(credentialHelperPids(1200, "/fixture/agent-harness.app/Contents/MacOS/agent-harness", run)).toEqual([1201]);
    expect(calls).toEqual([
      ["pgrep", ["-P", "1200"]], ["ps", ["-ww", "-p", "1201", "-o", "comm="]], ["ps", ["-ww", "-p", "1202", "-o", "comm="]],
    ]);
  });

  it("proves main and Settings responsiveness before an unavailable prior read settles, then requires its rejection", async () => {
    let refuse!: () => void;
    const events: string[] = [];
    const window = { desktopShell: {
      secrets: { get: () => new Promise((_resolve, reject) => { events.push("read"); refuse = () => reject(new Error("Keychain unavailable")); }) },
      system: async () => { events.push("system"); return { platform: "darwin" }; },
    } };
    const document = new JSDOM('<section aria-label="Settings"></section>').window.document;
    const evaluate = async (expression: string) => await runInNewContext(expression, { window, document }) as unknown;
    await checkUnavailablePackagedCredential(evaluate, async () => {
      expect(events).toEqual(["read", "system"]);
      refuse();
    });
    expect(JSON.stringify(window)).not.toContain("__packagedCredentialCheck");
  });

  it("does not pass the unavailable-access check when a locked prior item unexpectedly reads successfully", async () => {
    const window = { desktopShell: { secrets: { get: async () => "token-for-tests" }, system: async () => ({ platform: "darwin" }) } };
    const document = new JSDOM('<section aria-label="Settings"></section>').window.document;
    const evaluate = async (expression: string) => await runInNewContext(expression, { window, document }) as unknown;
    await expect(checkUnavailablePackagedCredential(evaluate)).rejects.toThrow(/unavailable/);
  });

  it("requires fresh OS protection and readback, without returning the value through CDP", async () => {
    const tokens = new Map<string, string>();
    let protection = "os";
    const window = { desktopShell: { secrets: {
      protection: async () => protection,
      set: async (name: string, value: string) => { tokens.set(name, value); },
      get: async (name: string) => tokens.get(name),
      delete: async (name: string) => { tokens.delete(name); },
    } } };
    const results: unknown[] = [];
    const evaluate = async (expression: string) => {
      const result = await runInNewContext(expression, { window }) as unknown;
      results.push(result);
      return result;
    };
    await checkFreshPackagedCredential(evaluate);
    expect(JSON.stringify(results)).not.toContain("credential-for-tests");
    expect(tokens.size).toBe(0);
    protection = "none";
    await expect(checkFreshPackagedCredential(evaluate)).rejects.toThrow(/OS-protected/);
    protection = "os";
    window.desktopShell.secrets.get = async () => "credential-for-tests-wrong";
    await expect(checkFreshPackagedCredential(evaluate)).rejects.toThrow(/read back correctly/);
  });

  it("requires navigation to answer protection inside the product's access deadline, with nothing left waiting", async () => {
    const settings = (rows: string[]) => {
      const dom = new JSDOM("");
      const show = (open: string) => {
        dom.window.document.body.innerHTML = `<section aria-label="Settings"><nav aria-label="Settings rows">${rows.map(row => `<button aria-label="${row}">${row}</button>`).join("")}</nav><section aria-label="${open}"></section></section>`;
        for (const row of rows) dom.window.document.querySelector(`[aria-label="${row}"]`)?.addEventListener("click", () => show(row));
      };
      show("Credential access");
      return dom.window.document;
    };
    const navigate = (protection: string, access: string | null, rows = ["About", "Your machines"]) => {
      const document = settings(rows);
      const window = { desktopShell: { secrets: { protection: async () => protection, access: async () => access } } };
      const budgets: number[] = [];
      const evaluate = async (expression: string, _stage?: string, milliseconds?: number) => {
        if (milliseconds !== undefined) budgets.push(milliseconds);
        return await runInNewContext(expression, { window, document }) as unknown;
      };
      return { run: () => checkQuietPackagedNavigation(evaluate), budgets, document };
    };
    const quiet = navigate("os", "denied");
    await quiet.run();
    expect(quiet.document.querySelector('section[aria-label="Your machines"]')).not.toBeNull();
    // A probe that raised a prompt would wait out the product's 30-second deadline.
    expect(Math.max(...quiet.budgets)).toBeLessThan(30_000);
    await navigate("os", null).run();
    await expect(navigate("none", "denied").run()).rejects.toThrow(/fresh OS-protected storage/);
    await expect(navigate("os", "waiting").run()).rejects.toThrow(/no Keychain access waiting/);
    await expect(navigate("os", "denied", ["About"]).run()).rejects.toThrow(/offer Your machines/);
  });

  it("keeps the combined update request within its existing two-minute deadline", async () => {
    vi.useFakeTimers();
    try {
      const p = page("token-for-tests-kept");
      const budgets: number[] = [];
      const evaluate = async (expression: string, stage?: string, milliseconds?: number): Promise<unknown> => {
        if (milliseconds !== undefined) budgets.push(milliseconds);
        const value = await p.evaluate(expression, stage);
        await vi.advanceTimersByTimeAsync(60_000);
        return value;
      };
      await expect(askForPackagedUpdate(evaluate, "0.2.0")).rejects.toThrow("read prior discovery");
      expect(budgets).toEqual([120_000, 60_000]);
      expect(p.updates).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("names each awaited update operation without returning the kept credential", async () => {
    const p = page("token-for-tests-kept");
    await askForPackagedUpdate(p.evaluate, "0.2.0");
    expect(p.stages).toEqual(["read prior credential", "read local grant", "read prior discovery", "read carried server", "authorize carried update", "read update response", "main responsiveness after credential access", "finish carried update check"]);
    expect(JSON.stringify(p.results)).not.toContain("token-for-tests-kept");
  });

  it.each([false, true])("finishes loading before ready, then seeds the credential with failure=%s", (failEncryption) => {
    const work = mkdtempSync(join(tmpdir(), "credential-fixture-"));
    try {
      const app = join(work, "app");
      prepareCredentialFixture(app);
      const electron = join(app, "node_modules", "electron");
      mkdirSync(electron, { recursive: true });
      writeFileSync(join(electron, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
      // Electron 44 imports its ESM entry before appCodeLoaded permits ready. No native Electron runs.
      writeFileSync(join(electron, "index.js"), `
import { Buffer } from 'node:buffer';
export let ready;
export let name;
export let userData;
export let exitCode;
export const phases = [];
const readiness = new Promise(resolve => { ready = () => { phases.push('ready'); resolve(); }; });
export const app = {
  setName: value => { name = value; },
  setPath: (key, value) => { if (key !== 'userData') throw new Error('Unexpected path'); userData = value; },
  whenReady: () => readiness,
  exit: code => { exitCode = code; phases.push('exit'); },
};
export const safeStorage = { encryptString: value => {
  if (phases[0] !== 'ready') throw new Error('Encryption before ready');
  phases.push('encrypt');
  if (process.env.FAIL_ENCRYPTION === 'true') throw new Error('Encryption unavailable');
  return Buffer.from('v10' + value);
} };
`);
      const secret = join(work, "credential.secret");
      const seed = join(work, "seed.json");
      writeFileSync(seed, JSON.stringify({ token: "credential-for-tests", file: secret }));
      const boot = join(app, "boot.mjs");
      writeFileSync(boot, `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { app, ready, name, userData, exitCode, phases } from 'electron';
await import('./main.js');
assert.equal(name, 'agent-harness');
assert.equal(userData, process.env.DESKTOP_FIXTURE);
assert.equal(exitCode, undefined);
assert.equal(existsSync(process.env.SECRET_FIXTURE), false);
assert.deepEqual(phases, []);
ready();
await Promise.resolve();
assert.equal(exitCode, process.env.FAIL_ENCRYPTION === 'true' ? 1 : 0);
assert.deepEqual(phases, ['ready', 'encrypt', 'exit']);
`);
      const result = spawnSync(process.execPath, [boot], { env: { ...process.env,
        CREDENTIAL_FIXTURE: seed, DESKTOP_FIXTURE: join(work, "desktop"), SECRET_FIXTURE: secret,
        FAIL_ENCRYPTION: String(failEncryption),
      }, encoding: "utf8", timeout: 10_000 });
      // A cyclic entry/ready await exits with Node's unsettled-top-level-await status, never a short clock race.
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(secret)).toBe(!failEncryption);
      if (!failEncryption) {
        expect(readFileSync(secret).toString()).toBe("v10credential-for-tests");
        expect(statSync(secret).mode & 0o777).toBe(0o600);
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("preserves framework links and executable permissions in a self-contained app copy", () => {
    const work = mkdtempSync(join(tmpdir(), "packaged-app-links-"));
    try {
      const source = join(work, "source.app");
      const installed = join(work, "installed.app");
      const framework = "Contents/Frameworks/ReactiveObjC.framework";
      const root = join(source, framework);
      mkdirSync(join(root, "Versions/A/Resources"), { recursive: true });
      writeFileSync(join(root, "Versions/A/ReactiveObjC"), "framework executable for tests", { mode: 0o755 });
      writeFileSync(join(root, "Versions/A/Resources/Info.plist"), "framework resources for tests");
      symlinkSync("A", join(root, "Versions/Current"));
      symlinkSync("Versions/Current/ReactiveObjC", join(root, "ReactiveObjC"));
      symlinkSync("Versions/Current/Resources", join(root, "Resources"));
      copyPackagedDesktop(source, installed);
      const copied = join(installed, framework);
      expect(readlinkSync(join(copied, "Versions/Current"))).toBe("A");
      expect(readlinkSync(join(copied, "ReactiveObjC"))).toBe("Versions/Current/ReactiveObjC");
      expect(readlinkSync(join(copied, "Resources"))).toBe("Versions/Current/Resources");
      rmSync(source, { recursive: true });
      expect(readFileSync(join(copied, "Resources/Info.plist"), "utf8")).toBe("framework resources for tests");
      expect(readFileSync(join(copied, "ReactiveObjC"), "utf8")).toBe("framework executable for tests");
      expect(statSync(join(copied, "ReactiveObjC")).mode & 0o111).toBe(0o111);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("prepares an older runtime in the release layout without changing dependencies or the replacement", async () => {
    const build = fixtureBuild({ host: "darwin-arm64" });
    try {
      await buildRelease(build.options({ platforms: ["darwin-arm64"] }), build.seams);
      const source = join(build.out, "source-server");
      const prior = join(build.out, "prior-server");
      mkdirSync(source);
      execFileSync("tar", ["-xf", join(build.out, "agent-harness-darwin-arm64.tar.gz"), "-C", source]);
      cpSync(source, prior, { recursive: true });
      const manifest = (root: string, path: string): unknown => JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
      stampPriorPackagedServer(prior, "0.0.0-0");
      expect(manifest(prior, "node_modules/@agent-harness/environment")).toMatchObject({ version: "0.0.0-0" });
      expect(manifest(prior, "node_modules/@agent-harness/contracts")).toMatchObject({ version: "0.0.0-0" });
      expect(manifest(prior, "packages/cli")).toMatchObject({ version: "0.0.0-0", launcherProtocol: 1 });
      expect(manifest(prior, "node_modules/zod")).toEqual(manifest(source, "node_modules/zod"));
      expect(manifest(source, "node_modules/@agent-harness/environment")).toMatchObject({ version: "0.5.0" });
      expect(manifest(source, "packages/cli")).toMatchObject({ version: "0.5.0" });
    } finally {
      build.remove();
    }
  });

  it("retries transient page-context errors during preload, control, and Settings readiness", async () => {
    const dom = new JSDOM('<button aria-label="Settings">Settings</button>');
    try {
      const attempts = new Map<string, number>();
      let clicks = 0;
      dom.window.document.querySelector("button")?.addEventListener("click", () => {
        clicks++;
        dom.window.document.body.innerHTML += '<section aria-label="Settings"></section>';
      });
      const evaluate = async (expression: string): Promise<unknown> => {
        const count = (attempts.get(expression) ?? 0) + 1;
        attempts.set(expression, count);
        if (count === 1) throw new Error("Packaged page evaluation failed");
        return runInNewContext(expression, { document: dom.window.document, window: { desktopShell: {} } });
      };
      await openPackagedSettings(evaluate);
      expect([...attempts.values()]).toEqual([2, 2, 2]);
      expect(clicks).toBe(1);
      expect(await packagedSettingsOpen(evaluate)).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("waits for the Settings control to mount before clicking it", async () => {
    const dom = new JSDOM("<main></main>");
    try {
      const evaluate = async (expression: string): Promise<unknown> => runInNewContext(expression, { document: dom.window.document });
      expect(await clickPackagedSettings(evaluate)).toBe(false);
      dom.window.document.body.innerHTML = '<button aria-label="Settings">Settings</button>';
      let clicks = 0;
      dom.window.document.querySelector("button")?.addEventListener("click", () => { clicks++; });
      expect(await clickPackagedSettings(evaluate)).toBe(true);
      expect(clicks).toBe(1);
    } finally {
      dom.window.close();
    }
  });

  it("recognizes the named Settings section without requiring an explicit accessibility role", async () => {
    const dom = new JSDOM('<button aria-label="Settings">Settings</button><section aria-label="Settings"></section>');
    try {
      const evaluate = async (expression: string): Promise<unknown> => runInNewContext(expression, { document: dom.window.document });
      expect(await packagedSettingsOpen(evaluate)).toBe(true);
      dom.window.document.querySelector("section")?.remove();
      expect(await packagedSettingsOpen(evaluate)).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("uses the kept client credential and the carried server to request the upgrade", async () => {
    const p = page("token-for-tests");
    await askForPackagedUpdate(p.evaluate, "0.2.0");
    expect(p.updates).toEqual([{
      address: "http://127.0.0.1:4777/api/update",
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token-for-tests" },
      body: JSON.stringify({ version: "0.2.0", artefactPath: "/fixture/app/server" }),
    }]);
  });

  it("fails when the replacement cannot read the prior credential, without exchanging a fresh grant", async () => {
    const p = page(undefined);
    await expect(askForPackagedUpdate(p.evaluate, "0.2.0")).rejects.toThrow(/prior install's credential/);
    expect(p.updates).toEqual([]);
  });

  it("fails when the kept credential cannot authorize the update", async () => {
    await expect(askForPackagedUpdate(page("token-for-tests", 401).evaluate, "0.2.0")).rejects.toThrow(/retained or recovered credential must authorize/);
  });

  it("refuses to count a fresh install already at the release version as an upgrade", async () => {
    await expect(askForPackagedUpdate(page("token-for-tests", 200, "0.2.0").evaluate, "0.2.0")).rejects.toThrow(/exercise an upgrade/);
  });
});
