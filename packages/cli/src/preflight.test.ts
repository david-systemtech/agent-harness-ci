import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, parsePreflightReport } from "@agent-harness/contracts";
import { DATABASE_SCHEMA_VERSION, HARNESS_VERSION, type PreflightSeams } from "@agent-harness/environment";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

/**
 * `preflight` (launcher-update spec, "Preflight"; #339): the verb the
 * launcher runs on a staged version before it installs it. Run from the
 * build in a process of its own, as the launcher runs it, it loads the real
 * SQLite, `node-pty` and bundled Claude binary; in process, with a check
 * failing through the CLI's seams.
 */

const entry = new URL("./main.ts", import.meta.url).pathname;
const tsx = createRequire(import.meta.url).resolve("tsx");

/** How long the process may take: tsx loads and transforms the whole environment package first, which took 20 s and more on a loaded runner (#634). */
const CLI_PROCESS_MS = 120_000;

/** The CLI in-process under `seams`, with what it printed. */
const inProcess = async (args: string[], seams: PreflightSeams) => {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), preflight: seams });
  return { code, stdout, stderr };
};

const passing: PreflightSeams = {
  platform: "linux",
  loadPty: () => ({}),
  claudeExecutable: "/sdk/claude",
  runClaude: async () => ({ code: 0, stdout: "2.1.283 (Claude Code)\n", stderr: "" }),
};

describe("agent-harness preflight, run from the build", { timeout: CLI_PROCESS_MS }, () => {
  it("prints one JSON document with its version, protocol, launcher protocol and database schema, and exits 0", async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, entry, "preflight"]);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(parsePreflightReport(stdout)).toEqual({
      version: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      launcherProtocol: LAUNCHER_PROTOCOL,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      bundledClaudeCodeVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) as unknown as string,
    });
    expect(stderr).toBe(process.platform === "darwin" || process.platform === "win32" ? "agent-harness preflight: keychain: @napi-rs/keyring loaded.\n" : "");
  });
});

describe("agent-harness preflight", () => {
  it.each(["darwin", "win32"] as const)("reports a loaded keychain binding on %s to stderr while stdout remains the launcher report", async (platform) => {
    const { code, stdout, stderr } = await inProcess(["preflight"], { ...passing, platform, loadKeychain: async () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }) });
    expect(code).toBe(0);
    expect(parsePreflightReport(stdout)?.version).toBe(HARNESS_VERSION);
    expect(stderr).toBe("agent-harness preflight: keychain: @napi-rs/keyring loaded.\n");
  });

  it.each(["darwin", "win32"] as const)("exits 1 on %s when the binding cannot load, so the launcher refuses the staged version", async (platform) => {
    const { code, stdout, stderr } = await inProcess(["preflight"], { ...passing, platform, loadKeychain: async () => { throw new Error("Cannot find native binding for this platform"); } });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("agent-harness preflight failed: keychain: @napi-rs/keyring did not load: Cannot find native binding for this platform\n");
  });

  it("prints the report alone on its standard output when every check passes", async () => {
    const { code, stdout, stderr } = await inProcess(["preflight"], passing);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      version: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      launcherProtocol: LAUNCHER_PROTOCOL,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      bundledClaudeCodeVersion: "2.1.283",
    });
    expect(stderr).toBe("");
  });

  it("exits 1 naming what did not load, each on a line of its own, and prints no report", async () => {
    const { code, stdout, stderr } = await inProcess(["preflight"], {
      ...passing,
      loadPty: () => {
        throw new Error("This environment cannot start a pseudo-terminal: node-pty did not load (invalid ELF header).");
      },
      claudeExecutable: null,
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      [
        "agent-harness preflight failed: node-pty: This environment cannot start a pseudo-terminal: node-pty did not load (invalid ELF header).",
        "agent-harness preflight failed: claude: The bundled Claude binary was not found for this platform.",
        "",
      ].join("\n"),
    );
  });

  it("takes no arguments", async () => {
    const { code, stdout, stderr } = await inProcess(["preflight", "--data-dir", "/tmp/x"], passing);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^Unknown option '--data-dir'/);
    expect(stderr).toContain("agent-harness preflight\n");
  });
});
