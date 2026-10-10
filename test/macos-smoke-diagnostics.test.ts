import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Peer {
  onmessage?: (message: { data: string }) => void;
  onclose?: () => void;
  send: (frame: string) => void;
  close: () => void;
}
const script = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-desktop-update-smoke.mjs")).href;
const { createCdpEvaluator } = await import(script) as {
  createCdpEvaluator: (peer: Peer, options?: { onTimeout?: (error: Error) => Promise<void>; redact?: (text: string) => string }) => {
    evaluate: (expression: string, stage: string, milliseconds?: number, options?: { expectDisconnect: boolean }) => Promise<unknown>;
    diagnostic: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    enableDiagnostics: () => Promise<unknown>;
    errors: () => unknown[];
    close: () => void;
  };
};
interface DiagnosticCall { command: string; args: string[] }
const diagnostics = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-smoke-diagnostics.mjs")).href;
const { collectRendererSmokeDiagnostics, collectMacosSmokeDiagnostics, executeDiagnostic, executeSwift, swiftCompileTimeout, finishSmoke, persistDesktopLog, persistSmokeFailure, redactDiagnostic } = await import(diagnostics) as {
  collectRendererSmokeDiagnostics: (input: {
    directory: string; privateDirectory: string; secrets: string[];
    cdp: { diagnostic: (method: string, params?: Record<string, unknown>) => Promise<unknown>; errors: () => unknown[] };
    execute: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  }) => Promise<void>;
  executeDiagnostic: (command: string, args: string[], options?: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  executeSwift: (args: string[], execute?: (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>) => Promise<{ stdout: string; stderr: string }>;
  swiftCompileTimeout: number;
  persistDesktopLog: (directory: string, privateDirectory: string, secrets: string[]) => void;
  persistSmokeFailure: (directory: string, error: Error, secrets: string[]) => void;
  redactDiagnostic: (text: string, secrets?: string[]) => string;
  finishSmoke: (original: Error | undefined, cleanup: (() => Promise<void>)[], report: (error: Error) => void) => Promise<void>;
  collectMacosSmokeDiagnostics: (input: {
    directory: string; privateDirectory: string; pid: number; error: Error;
    secrets: string[]; execute: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  }) => Promise<void>;
};
afterEach(() => { vi.useRealTimers(); });

describe("packaged macOS timeout evidence", () => {
  it("rejects unrelated work on an expected quit and identifies unexpected disconnects without credentials", async () => {
    const peer: Peer = { send: () => {}, close: () => {} };
    const cdp = createCdpEvaluator(peer, { redact: text => redactDiagnostic(text, ["token-for-tests-kept"]) });
    const credential = cdp.evaluate("secrets.get('token-for-tests-kept')", "read replacement credential").catch((error: unknown) => error);
    const quitting = cdp.evaluate("window.desktopShell.window.close()", "close replacement", 10_000, { expectDisconnect: true });
    peer.onclose?.();
    await expect(quitting).resolves.toBeUndefined();
    expect(await credential).toMatchObject({ smokeDisconnected: true, stage: "read replacement credential",
      expression: "secrets.get('<REDACTED>')", message: expect.stringContaining("read replacement credential") });
    expect(String(await credential)).not.toContain("token-for-tests-kept");
    // A later request cannot hang on a socket that already closed, even if it asks to quit.
    await expect(cdp.evaluate("window.desktopShell.window.close()", "stale page quit", 10_000, { expectDisconnect: true }))
      .rejects.toMatchObject({ smokeDisconnected: true, stage: "stale page quit" });
  });

  it("records renderer errors without retaining credentials and bounds diagnostics without recursive timeout collection", async () => {
    vi.useFakeTimers();
    const collected: string[] = [];
    const peer: Peer = { close: () => {}, send: (message) => {
      const request: { id: number; method: string } = JSON.parse(message);
      if (request.method === "Runtime.enable") peer.onmessage?.({ data: JSON.stringify({ id: request.id, result: {} }) });
    } };
    const cdp = createCdpEvaluator(peer, { onTimeout: async (error) => { collected.push(error.message); }, redact: text => redactDiagnostic(text, ["token-for-tests-kept"]) });
    await cdp.enableDiagnostics();
    peer.onmessage?.({ data: JSON.stringify({ method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "connection refused token-for-tests-kept" }] } }) });
    peer.onmessage?.({ data: JSON.stringify({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { exception: { description: "grant failure token-for-tests-kept" } } } }) });
    expect(JSON.stringify(cdp.errors())).toContain("connection refused <REDACTED>");
    expect(JSON.stringify(cdp.errors())).toContain("grant failure <REDACTED>");
    expect(JSON.stringify(cdp.errors())).not.toContain("token-for-tests-kept");
    const outcome = cdp.diagnostic("Page.captureScreenshot").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ smokeTimeout: true });
    expect(collected).toEqual([]);
  });

  it("keeps an expected quit bounded and rejects page errors before shutdown", async () => {
    vi.useFakeTimers();
    const peer: Peer = { close: () => {}, send: message => {
      const request = JSON.parse(message) as { id: number; params: { expression: string } };
      if (request.params.expression === "pendingQuit()") return;
      peer.onmessage?.({ data: JSON.stringify({ id: request.id, result: { exceptionDetails: {
        text: "The prior credential read is no longer pending",
      } } }) });
    } };
    const cdp = createCdpEvaluator(peer);
    await expect(cdp.evaluate("invalidQuit()", "pending-access quit", 10_000, { expectDisconnect: true }))
      .rejects.toThrow(/prior credential read is no longer pending/);
    const stalled = cdp.evaluate("pendingQuit()", "pending-access quit", 10_000, { expectDisconnect: true }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stalled).toMatchObject({ smokeTimeout: true, stage: "pending-access quit" });
  });

  it("captures window text, names, machine phases, notices, console errors and a sanitized CDP screenshot", async () => {
    const work = mkdtempSync(join(tmpdir(), "macos-renderer-evidence-"));
    const directory = join(work, "upload");
    const privateDirectory = join(work, "private");
    mkdirSync(privateDirectory);
    const dom = new JSDOM(`<section aria-label="Your machines"><section data-machine-card data-environment-id="local-for-tests" data-machine-kind="local" data-machine-phase="blocked" data-machine-blocked="revoked" data-machine-action="re-pair" aria-labelledby="local-heading"><header><h3 id="local-heading">desk</h3><span>This machine</span></header><p>Pair again token-for-tests-kept</p></section></section><section aria-label="Credential access"><li>Stored credentials could not be read</li></section><input value="token-for-tests-hidden"><div hidden>token-for-tests-hidden</div>`);
    dom.window.document.body.innerHTML += `<span hidden data-window-environments='[{"environmentId":"local-for-tests","name":"desk","kind":"local","phase":"blocked","blocked":"revoked","action":"re-pair"}]'></span>`;
    try {
      await collectRendererSmokeDiagnostics({ directory, privateDirectory, secrets: ["token-for-tests-kept"],
        cdp: { errors: () => [{ type: "error", text: "connection refused token-for-tests-kept" }], diagnostic: async (method, params) => {
          if (method === "Runtime.evaluate") return { result: { value: runInNewContext(String(params?.["expression"]), { document: dom.window.document, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) }) as unknown } };
          if (method === "Accessibility.getFullAXTree") return { nodes: [{ ignored: false, role: { value: "button" }, name: { value: "Pair again token-for-tests-kept" }, value: { value: "never-upload-this-value" } }] };
          if (method === "Page.captureScreenshot") return { data: Buffer.from("private window image").toString("base64") };
          throw new Error("unexpected diagnostic");
        } }, execute: async (_command, args) => {
          expect(readFileSync(args.at(-2) ?? "", "utf8")).toBe("private window image");
          writeFileSync(args.at(-1) ?? "", "sanitized window image");
          return { stdout: "", stderr: "" };
        } });
      const state = JSON.parse(readFileSync(join(directory, "renderer-state.json"), "utf8")) as { windowEnvironments: unknown[]; environments: unknown[]; notices: string[]; visibleText: string };
      expect(state.windowEnvironments).toEqual([expect.objectContaining({ environmentId: "local-for-tests", kind: "local", phase: "blocked", blocked: "revoked", action: "re-pair" })]);
      expect(state.environments).toEqual([expect.objectContaining({ environmentId: "local-for-tests", kind: "local", phase: "blocked", blocked: "revoked", action: "re-pair", name: "desk", badges: ["This machine"] })]);
      expect(state.notices).toEqual(["Stored credentials could not be read"]);
      expect(state.visibleText).toContain("Pair again <REDACTED>");
      expect(readFileSync(join(directory, "renderer-accessibility.json"), "utf8")).toContain("Pair again <REDACTED>");
      expect(readFileSync(join(directory, "renderer-console.json"), "utf8")).toContain("connection refused <REDACTED>");
      expect(readFileSync(join(directory, "renderer-screenshot.png"), "utf8")).toBe("sanitized window image");
      for (const name of readdirSync(directory)) expect(readFileSync(join(directory, name), "utf8")).not.toMatch(/token-for-tests-kept|token-for-tests-hidden|never-upload-this-value|private window image/);
      expect(readdirSync(privateDirectory)).toEqual([]);
    } finally { dom.window.close(); rmSync(work, { recursive: true, force: true }); }
  });

  it("bridges CoreGraphics window arrays before sanitizing the captured window list", async () => {
    const work = mkdtempSync(join(tmpdir(), "macos-window-bridge-"));
    const directory = join(work, "upload");
    const privateDirectory = join(work, "private");
    mkdirSync(privateDirectory);
    // JXA returns a Core Foundation reference, not an Objective-C collection.
    const cfArray = { reference: [{ kCGWindowOwnerName: "SecurityAgent", kCGWindowName: "Allow token-for-tests-kept", kCGWindowOwnerPID: 123, kCGWindowBounds: { X: 2, Y: 3, Width: 400, Height: 250 } }] };
    try {
      await collectMacosSmokeDiagnostics({ directory, privateDirectory, pid: 12345,
        error: new Error("read prior credential timed out"), secrets: ["token-for-tests-kept"],
        execute: async (command, args) => {
          if (!command.endsWith("osascript")) throw new Error("other capture unavailable");
          const stdout = runInNewContext(args.at(-1) ?? "", {
            $: { CGWindowListCopyWindowInfo: () => cfArray },
            ObjC: { import: () => {}, deepUnwrap: (value: unknown) => value,
              castRefToObject: (value: typeof cfArray) => value.reference },
          }) as string;
          return { stdout, stderr: "" };
        } });
      expect(JSON.parse(readFileSync(join(directory, "windows.json"), "utf8"))).toEqual([
        { owner: "SecurityAgent", title: "Allow <REDACTED>", pid: 123, bounds: { X: 2, Y: 3, Width: 400, Height: 250 } },
      ]);
      expect(existsSync(join(directory, "windows.json.error.txt"))).toBe(false);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("persists cleanup-only failures and desktop output before deleting private captures", async () => {
    const work = mkdtempSync(join(tmpdir(), "macos-cleanup-evidence-"));
    const directory = join(work, "upload");
    const privateDirectory = join(work, "private");
    const secrets = ["token-for-tests-kept"];
    mkdirSync(privateDirectory);
    writeFileSync(join(privateDirectory, "desktop.log"), "desktop output token-for-tests-kept");
    try {
      await expect(finishSmoke(undefined, [
        async () => { throw new Error("service uninstall failed token-for-tests-kept"); },
        async () => { rmSync(privateDirectory, { recursive: true }); },
      ], error => {
        persistSmokeFailure(directory, error, secrets);
        persistDesktopLog(directory, privateDirectory, secrets);
      })).rejects.toThrow("cleanup failed");
      expect(readFileSync(join(directory, "failure.txt"), "utf8")).toContain("service uninstall failed <REDACTED>");
      expect(readFileSync(join(directory, "desktop.log"), "utf8")).toBe("desktop output <REDACTED>");
      expect(existsSync(privateDirectory)).toBe(false);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("persists the original error when CLI setup fails before smoke collection starts", () => {
    const work = mkdtempSync(join(tmpdir(), "macos-early-failure-"));
    const directory = join(work, "upload");
    try {
      // No app argument: argument validation fails before any native macOS command can run.
      expect(() => execFileSync(process.execPath, [fileURLToPath(script)], {
        cwd: work, env: { ...process.env, SMOKE_DIAGNOSTICS: directory }, stdio: "pipe",
      })).toThrow();
      expect(readFileSync(join(directory, "failure.txt"), "utf8")).toContain("Received undefined");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("gives every Swift script the cold-compile allowance, the native checks' own fixtures included", async () => {
    const calls: { command: string; args: string[]; timeout: number }[] = [];
    await executeSwift(["fixture.swift", "text", "raw.png"], async (command, args, { timeout }) => {
      calls.push({ command, args, timeout });
      return { stdout: "", stderr: "" };
    });
    expect(calls).toEqual([{ command: "/usr/bin/swift", args: ["fixture.swift", "text", "raw.png"], timeout: swiftCompileTimeout }]);
    // A fresh hosted Mac compiles a Swift script in about 15 to 20 seconds before it runs (#1684).
    expect(swiftCompileTimeout).toBeGreaterThanOrEqual(120_000);
    const native = readFileSync(join(import.meta.dirname, "..", "scripts", "macos-smoke-diagnostics-native.test.mjs"), "utf8");
    expect(native).toContain("executeSwift(");
    // No call names a Swift command, in any quote style, by path or by name, outside executeSwift.
    expect(native).not.toMatch(/\(\s*["'`](?:[^"'`]*\/)?swift["'`]\s*,/);
    // The only direct calls: osascript, and the cold-cache wrapper passing executeSwift's options on.
    expect(native.match(/executeDiagnostic\(/g)).toHaveLength(2);
    expect(native).toContain('return executeDiagnostic(command, ["-module-cache-path", join(work, "swift-cache"), ...args], options);');
  });

  it("retains a failed command's exit status and captured stderr", async () => {
    await expect(executeDiagnostic(process.execPath, ["-e", "process.stderr.write('compiler detail'); process.exit(17)"]))
      .rejects.toMatchObject({ code: 17, stderr: "compiler detail", signal: null, killed: false });
  });

  it.each(["compiler", "OCR"])("bounds and redacts %s failure details from both screenshot collectors while retaining the smoke error", async stage => {
    const work = mkdtempSync(join(tmpdir(), "macos-redaction-failure-"));
    const directory = join(work, "upload");
    const privateDirectory = join(work, "private");
    mkdirSync(privateDirectory);
    const original = new Error("original readiness timeout");
    const execute = async (command: string, args: string[]) => {
      if (command.endsWith("screencapture")) writeFileSync(args.at(-1) ?? "", "private screenshot");
      if (command.endsWith("swift")) {
        writeFileSync(args.at(-1) ?? "", "partially masked screenshot");
        throw Object.assign(new Error(`${stage} failed token-for-tests-kept`), {
          code: 17, signal: null, killed: false,
          stderr: `${stage}: token-for-tests-kept Authorization: Bearer token-for-tests-unlisted\n` + "x".repeat(100_000),
        });
      }
      return { stdout: "[]", stderr: "" };
    };
    try {
      await Promise.all([
        collectMacosSmokeDiagnostics({ directory, privateDirectory, pid: 123, error: original, secrets: ["token-for-tests-kept"], execute }),
        collectRendererSmokeDiagnostics({ directory, privateDirectory, secrets: ["token-for-tests-kept"], execute,
          cdp: { errors: () => [], diagnostic: async method => {
            if (method === "Page.captureScreenshot") return { data: Buffer.from("private screenshot").toString("base64") };
            if (method === "Runtime.evaluate") return { result: { value: {} } };
            return { nodes: [] };
          } },
        }),
      ]);
      const renderer = JSON.parse(readFileSync(join(directory, "renderer-screenshot.png.error.json"), "utf8")) as { code: number; stderr: string };
      expect(renderer).toMatchObject({ code: 17, signal: null, killed: false, stderr: expect.stringContaining(`${stage}: <REDACTED>`) });
      expect(renderer.stderr.length).toBeLessThanOrEqual(32_000);
      const runner = readFileSync(join(directory, "screenshot.png.error.txt"), "utf8");
      expect(runner).toContain('"code": 17');
      expect(runner).toContain(`${stage}: <REDACTED>`);
      expect(runner.length).toBeLessThan(34_000);
      expect(readdirSync(directory).filter(name => name.endsWith(".png"))).toEqual([]);
      expect(readdirSync(privateDirectory)).toEqual([]);
      for (const name of readdirSync(directory)) expect(readFileSync(join(directory, name), "utf8"))
        .not.toMatch(/token-for-tests-kept|token-for-tests-unlisted|private screenshot|partially masked/);
      await expect(finishSmoke(original, [], () => {})).rejects.toBe(original);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("forces a diagnostic tool to finish even when it ignores SIGTERM", async () => {
    const work = mkdtempSync(join(tmpdir(), "macos-stubborn-diagnostic-"));
    const pidFile = join(work, "ready.pid");
    let settled = false;
    const result = executeDiagnostic(process.execPath, ["-e", `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);
    `, pidFile], { timeout: 1000 }).then(
      value => { settled = true; return value; },
      (error: unknown) => { settled = true; return error; },
    );
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      const deadline = new Promise(resolve => { timer = globalThis.setTimeout(() => resolve("still pending"), 2200); });
      const outcome = await Promise.race([result, deadline]);
      expect(existsSync(pidFile), "the real child installed its signal handler").toBe(true);
      expect(outcome).toMatchObject({ killed: true, signal: "SIGKILL" });
    } finally {
      globalThis.clearTimeout(timer);
      if (!settled && existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      await result;
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("names a native evaluation exception without exposing its credential", async () => {
    const peer: Peer = { close: () => {}, send: (message) => {
      const request: { id: number } = JSON.parse(message);
      peer.onmessage?.({ data: JSON.stringify({ id: request.id, result: { exceptionDetails: { exception: { description: "Keychain denied token-for-tests-kept" } } } }) });
    } };
    const cdp = createCdpEvaluator(peer, { redact: text => redactDiagnostic(text, ["token-for-tests-kept"]) });
    const result = cdp.evaluate("window.desktopShell.secrets.get('item')", "read prior credential").catch((error: unknown) => error);
    expect(await result).toMatchObject({ message: expect.stringContaining("read prior credential") });
    expect(await result).toMatchObject({ message: expect.stringContaining("Keychain denied") });
    expect(String(await result)).not.toContain("token-for-tests-kept");
  });

  it("keeps other evidence when a native tool fails and never uploads a failed screenshot redaction", async () => {
    const work = mkdtempSync(join(tmpdir(), "macos-partial-evidence-"));
    const directory = join(work, "upload");
    const privateDirectory = join(work, "private");
    mkdirSync(privateDirectory);
    try {
      await collectMacosSmokeDiagnostics({ directory, privateDirectory, pid: 12345,
        error: new Error("native read timed out"), secrets: ["token-for-tests-kept"],
        execute: async (command, args) => {
          if (command.endsWith("sample")) throw new Error("sample refused token-for-tests-kept");
          if (command.endsWith("screencapture")) writeFileSync(args.at(-1) ?? "", "private screenshot");
          if (command.endsWith("swift")) {
            writeFileSync(args.at(-1) ?? "", "partly redacted token-for-tests-kept");
            throw new Error("redaction failed token-for-tests-kept");
          }
          return { stdout: '[{"owner":"SecurityAgent","title":"Allow access"}]', stderr: "" };
        } });
      expect(JSON.parse(readFileSync(join(directory, "windows.json"), "utf8"))).toEqual([{ owner: "SecurityAgent", title: "Allow access" }]);
      expect(readdirSync(directory)).not.toContain("screenshot.png");
      expect(readdirSync(privateDirectory)).not.toContain("runner-screen.png");
      for (const name of readdirSync(directory)) expect(readFileSync(join(directory, name), "utf8")).not.toContain("token-for-tests-kept");
      expect(readFileSync(join(directory, "sample.txt.error.txt"), "utf8")).toContain("sample refused");
      expect(readFileSync(join(directory, "screenshot.png.error.txt"), "utf8")).toContain("redaction failed");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("still fails when cleanup alone fails after successful checks", async () => {
    const reported: Error[] = [];
    await expect(finishSmoke(undefined, [async () => { throw new Error("service uninstall failed"); }], error => reported.push(error)))
      .rejects.toThrow("cleanup failed");
    expect(reported.map(error => error.message)).toEqual(["service uninstall failed"]);
  });

  it("redacts an unlisted authorization header as well as known fixture credentials", () => {
    expect(redactDiagnostic("Authorization: Bearer token-for-tests-unlisted\npassword=not-a-real-password\ncredential token-for-tests-kept", ["token-for-tests-kept"]))
      .not.toMatch(/token-for-tests-unlisted|not-a-real-password|token-for-tests-kept/);
  });

  it("restores every resource and reports cleanup failures while throwing the original timeout", async () => {
    const original = new Error("credential-read timed out");
    const stopped = new Error("SIGTERM timed out");
    const restored: string[] = [];
    const reported: Error[] = [];
    const result = finishSmoke(original, [
      async () => { throw stopped; },
      async () => { restored.push("service uninstalled"); },
      async () => { restored.push("keychain restored"); },
    ], (error) => reported.push(error)).catch((error: unknown) => error);
    expect(await result).toBe(original);
    expect(restored).toEqual(["service uninstalled", "keychain restored"]);
    expect(reported).toEqual([stopped]);
  });

  it("keeps a process sample, windows, redacted desktop output and sanitized screenshot outside the private files", async () => {
    const work = mkdtempSync(join(tmpdir(), "macos-timeout-evidence-"));
    const directory = join(work, "upload");
    const privateDirectory = join(work, "private");
    mkdirSync(privateDirectory);
    const calls: DiagnosticCall[] = [];
    writeFileSync(join(privateDirectory, "desktop.log"), 'credential token-for-tests-kept\n{"secret":"unlisted-for-tests"}');
    try {
      await collectMacosSmokeDiagnostics({ directory, privateDirectory, pid: 12345,
        error: Object.assign(new Error("Timed out at read prior credential"), { stage: "read prior credential", expression: "http({ authorization: 'Bearer ' + state.token })" }), secrets: ["token-for-tests-kept"],
        execute: async (command, args) => {
          calls.push({ command, args });
          if (command.endsWith("screencapture")) writeFileSync(args.at(-1) ?? "", "private screenshot");
          if (command.endsWith("swift")) writeFileSync(args.at(-1) ?? "", "sanitized screenshot");
          return { stdout: command.endsWith("sample") ? "main thread SecItemCopyMatching token-for-tests-kept" : '{"title":"credential token-for-tests-kept"}', stderr: "" };
        } });
      expect(JSON.parse(readFileSync(join(directory, "timeout.json"), "utf8"))).toMatchObject({ stage: "read prior credential", expression: expect.stringContaining("http(") });
      expect(readFileSync(join(directory, "sample.txt"), "utf8")).toContain("SecItemCopyMatching");
      expect(readFileSync(join(directory, "desktop.log"), "utf8")).toContain("<REDACTED>");
      for (const name of readdirSync(directory)) {
        expect(readFileSync(join(directory, name), "utf8")).not.toMatch(/token-for-tests-kept|unlisted-for-tests|private screenshot/);
      }
      expect(readFileSync(join(directory, "screenshot.png"), "utf8")).toBe("sanitized screenshot");
      expect(readFileSync(join(directory, "windows.json"), "utf8")).toContain("<REDACTED>");
      expect(calls.find(call => call.command.endsWith("sample"))?.args).toEqual(["12345", "2", "1"]);
      expect(calls.flatMap(call => call.args).join(" ")).not.toContain("token-for-tests-kept");
      expect(readdirSync(privateDirectory)).not.toContain("runner-screen.png");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("collects the timed-out operation before rejecting and keeps the error if collection fails", async () => {
    vi.useFakeTimers();
    const evidence: string[] = [];
    const peer: Peer = { send: () => {}, close: () => {} };
    const cdp = createCdpEvaluator(peer, { onTimeout: async (error) => {
      evidence.push(error.message);
      throw new Error("sample unavailable");
    } });
    const result = cdp.evaluate("window.desktopShell.secrets.get('item')", "read prior credential").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain("read prior credential");
    expect(await result).toMatchObject({ smokeTimeout: true, message: expect.stringContaining("read prior credential") });
  });

  it("identifies the stalled stage and expression at the existing two-minute CDP deadline", async () => {
    vi.useFakeTimers();
    const peer: Peer = { send: () => {}, close: () => {} };
    const cdp = createCdpEvaluator(peer);
    const result = cdp.evaluate("window.desktopShell.system()", "post-update responsiveness").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("post-update responsiveness") });
    expect(await result).toMatchObject({ message: expect.stringContaining("window.desktopShell.system()") });
  });
});
