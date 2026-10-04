import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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
    evaluate: (expression: string, stage: string) => Promise<unknown>;
    close: () => void;
  };
};
interface DiagnosticCall { command: string; args: string[] }
const diagnostics = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-smoke-diagnostics.mjs")).href;
const { collectMacosSmokeDiagnostics, finishSmoke, redactDiagnostic } = await import(diagnostics) as {
  redactDiagnostic: (text: string, secrets?: string[]) => string;
  finishSmoke: (original: Error | undefined, cleanup: (() => Promise<void>)[], report: (error: Error) => void) => Promise<void>;
  collectMacosSmokeDiagnostics: (input: {
    directory: string; privateDirectory: string; pid: number; error: Error;
    secrets: string[]; execute: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  }) => Promise<void>;
};
afterEach(() => { vi.useRealTimers(); });

describe("packaged macOS timeout evidence", () => {
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
