import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../adapters/claude/credentials.js";
import { loadSqlite } from "../event-log/sqlite.js";
import { HARNESS_VERSION } from "../serve/start.js";
import { applyMigrations, DATABASE_SCHEMA_VERSION } from "../event-log/migrations.js";
import { scriptedKeychain } from "../../test/keychain.js";
import { preflight, type PreflightSeams } from "./preflight.js";

/**
 * A version's preflight (launcher-update spec, "Preflight"; #339): what the
 * `preflight` verb runs before the launcher installs a version. It loads
 * SQLite and migrates a database in memory, loads `node-pty`, and runs the
 * bundled Claude binary's `--version`, then answers the version's identity,
 * or each check that failed. Here with its loaders and the binary scripted,
 * so no test spawns the binary; the CLI's tests run it from the build.
 */

/** A runner that answers `result` and records what it was asked to run. */
const scripted = (result: CommandResult) => {
  const calls: { executable: string; argv: readonly string[] }[] = [];
  const run: CommandRunner = async (executable, argv) => {
    calls.push({ executable, argv });
    return result;
  };
  return { run, calls };
};

const printsVersion = scripted({ code: 0, stdout: "2.1.283 (Claude Code)\n", stderr: "" });

/** Seams under which every check passes: this machine's SQLite, a `node-pty` that loads, and a binary that prints its version. */
const passing: PreflightSeams = { platform: "linux", loadPty: () => ({}), claudeExecutable: "/sdk/claude", runClaude: printsVersion.run };

const throwing = (message: string) => () => {
  throw new Error(message);
};

describe("a version's preflight", () => {
  it.each(["darwin", "win32"] as const)("refuses a version on %s whose keychain binding is missing or cannot load", async (platform) => {
    for (const load of ["not-installed", "does-not-load"] as const) {
      const keychain = scriptedKeychain({ load });
      const answer = await preflight({ ...passing, platform, loadKeychain: keychain.load });
      expect(answer).toEqual({ failures: [{ check: "keychain", message: expect.stringContaining(load === "not-installed" ? "Cannot find package '@napi-rs/keyring'" : "Cannot find native binding") }] });
      expect(keychain.loads()).toBe(1);
      expect(keychain.calls).toEqual([]);
    }
  });

  it.each(["darwin", "win32"] as const)("reports that the binding loaded on %s without reading or writing any keychain entry", async (platform) => {
    const keychain = scriptedKeychain();
    expect(await preflight({ ...passing, platform, loadKeychain: keychain.load })).toEqual({ report: expect.anything(), keychain: "loaded" });
    expect(keychain.loads()).toBe(1);
    expect(keychain.calls).toEqual([]);
  });

  it("does not load the keychain binding on Linux, where the vault is a file", async () => {
    const keychain = scriptedKeychain({ load: "not-installed" });
    const answer = await preflight({ ...passing, loadKeychain: keychain.load });
    expect(answer).toHaveProperty("report");
    expect(answer).not.toHaveProperty("keychain");
    expect(keychain.loads()).toBe(0);
  });

  it("reports the loaded binding even when another check fails", async () => {
    const keychain = scriptedKeychain();
    expect(await preflight({ ...passing, platform: "darwin", loadKeychain: keychain.load, claudeExecutable: null })).toEqual({
      keychain: "loaded",
      failures: [{ check: "claude", message: "The bundled Claude binary was not found for this platform." }],
    });
    expect(keychain.calls).toEqual([]);
  });

  it("answers the version's identity once SQLite, node-pty and the bundled Claude binary's --version all work", async () => {
    const { run, calls } = scripted({ code: 0, stdout: "2.1.283 (Claude Code)\n", stderr: "" });
    expect(await preflight({ ...passing, runClaude: run })).toEqual({
      report: {
        version: HARNESS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        launcherProtocol: LAUNCHER_PROTOCOL,
        databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
        bundledClaudeCodeVersion: "2.1.283",
      },
    });
    expect(calls).toEqual([{ executable: "/sdk/claude", argv: ["--version"] }]);
  });

  it("names the schema by the user_version a database has once this version's migrations are applied", () => {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: DATABASE_SCHEMA_VERSION });
    } finally {
      db.close();
    }
  });

  it("migrates a database in memory with this version's migrations, so a SQLite that cannot take them fails it", async () => {
    let opened = 0;
    const answer = await preflight({
      ...passing,
      loadSqlite: () => {
        const sqlite = loadSqlite();
        // A SQLite whose databases refuse every statement, as one too old for a migration's syntax does.
        class RefusingDatabase extends sqlite.DatabaseSync {
          constructor(path: string) {
            super(path);
            opened++;
          }
          override exec(): void {
            throw new Error("near \"STRICT\": syntax error");
          }
        }
        return { ...sqlite, DatabaseSync: RefusingDatabase };
      },
    });
    expect(opened).toBe(1);
    expect(answer).toEqual({ failures: [{ check: "sqlite", message: 'SQLite could not take this version\'s migrations: near "STRICT": syntax error' }] });
  });

  it("names each check that failed, all of them, in order: SQLite, node-pty, keychain, the Claude binary", async () => {
    const answer = await preflight({
      ...passing,
      platform: "win32",
      loadKeychain: scriptedKeychain({ load: "does-not-load" }).load,
      loadSqlite: throwing("No such built-in module: node:sqlite"),
      loadPty: throwing("This environment cannot start a pseudo-terminal: node-pty did not load (invalid ELF header)."),
      claudeExecutable: null,
      runClaude: printsVersion.run,
    });
    expect(answer).toEqual({
      failures: [
        { check: "sqlite", message: "SQLite did not load: No such built-in module: node:sqlite" },
        { check: "node-pty", message: "This environment cannot start a pseudo-terminal: node-pty did not load (invalid ELF header)." },
        { check: "keychain", message: "@napi-rs/keyring did not load: Cannot find native binding for this platform" },
        { check: "claude", message: "The bundled Claude binary was not found for this platform." },
      ],
    });
  });

  it("fails the Claude check when the binary cannot be run, fails, or prints no version, saying how", async () => {
    const cases: [CommandResult, string][] = [
      [{ code: null, stdout: "", stderr: "spawn /sdk/claude EACCES" }, "/sdk/claude --version could not be run: spawn /sdk/claude EACCES"],
      [{ code: 1, stdout: "", stderr: "Illegal instruction\n" }, "/sdk/claude --version exited with code 1: Illegal instruction"],
      [{ code: 2, stdout: "", stderr: "" }, "/sdk/claude --version exited with code 2"],
      [{ code: 0, stdout: "Claude Code\n", stderr: "" }, '/sdk/claude --version printed no version: "Claude Code"'],
    ];
    for (const [result, message] of cases) {
      expect(await preflight({ ...passing, runClaude: scripted(result).run }), JSON.stringify(result)).toEqual({ failures: [{ check: "claude", message }] });
    }
  });
});
