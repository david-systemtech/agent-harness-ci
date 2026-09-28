import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "./credentials.js";
import { readClaudeCodeVersion } from "./version.js";

/**
 * The bundled Claude Code's version (launcher-update spec, "Settings,
 * methods, notices and flags": `updates.status`), read from the binary's
 * `--version`, which needs no sign-in: against a scripted runner, so no test
 * spawns the binary.
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

describe("reading the bundled Claude Code's version", () => {
  it("runs the binary's --version and answers the version it prints", async () => {
    const { run, calls } = scripted({ code: 0, stdout: "2.1.283 (Claude Code)\n", stderr: "" });
    expect(await readClaudeCodeVersion({ executable: "/sdk/claude", run })).toBe("2.1.283");
    expect(calls).toEqual([{ executable: "/sdk/claude", argv: ["--version"] }]);
  });

  it("keeps a prerelease part", async () => {
    const { run } = scripted({ code: 0, stdout: "2.2.0-beta.3 (Claude Code)\n", stderr: "" });
    expect(await readClaudeCodeVersion({ executable: "/sdk/claude", run })).toBe("2.2.0-beta.3");
  });

  it("answers null, running nothing, when this platform has no bundled binary", async () => {
    const { run, calls } = scripted({ code: 0, stdout: "2.1.283 (Claude Code)\n", stderr: "" });
    expect(await readClaudeCodeVersion({ executable: null, run })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("answers null when the binary cannot be run, fails, or prints no version", async () => {
    for (const result of [
      { code: null, stdout: "", stderr: "spawn ENOENT" },
      { code: 1, stdout: "2.1.283 (Claude Code)\n", stderr: "" },
      { code: 0, stdout: "Claude Code\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]) {
      expect(await readClaudeCodeVersion({ executable: "/sdk/claude", run: scripted(result).run }), JSON.stringify(result)).toBeNull();
    }
  });
});
