import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installVersion } from "../../test/launcher-fixtures.js";
import { makeTempDir } from "../../test/service-helpers.js";
import { writeServiceState } from "../launch/state.js";
import { VERSION_SENTINEL, versionDirectory } from "../launch/versions.js";
import { pathLine, renderShim, SHIM_DIRECTORY, SHIM_FILES } from "./shim.js";

/**
 * The shim (#338): the `agent-harness` in the data directory's `bin` folder,
 * which runs the version the service state names active, so a terminal UI
 * started from it always matches its environment. Both kinds render from
 * fixtures; the `sh` one also runs here.
 */

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/service/${name}`, import.meta.url), "utf8");
const ECHO_CHILD = new URL("../../test/echo-child.ts", import.meta.url).pathname;
const posix = process.platform !== "win32";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempDataDir = (): string => {
  const dir = makeTempDir();
  cleanups.push(dir.remove);
  const dataDir = join(dir.path, "data dir");
  mkdirSync(dataDir);
  return dataDir;
};

const state = (activeVersion: string, launcherVersion = activeVersion) => ({
  activeVersion,
  previousVersion: null,
  launcherVersion,
  pendingUpdate: null,
  watchDeadline: null,
});

describe("the shim", () => {
  it("is bin/agent-harness on macOS and Linux, and bin\\agent-harness.cmd on Windows", () => {
    expect(SHIM_DIRECTORY).toBe("bin");
    expect(SHIM_FILES).toEqual({ sh: "agent-harness", cmd: "agent-harness.cmd" });
  });

  it("renders for sh as the fixture: the service state's active version, its own Node, the arguments as given", () => {
    expect(renderShim("sh", "/home/david/.local/state/agent-harness")).toBe(fixture("agent-harness-shim"));
  });

  it("renders for cmd as the fixture, with CRLF lines", () => {
    expect(renderShim("cmd", "C:\\Users\\david\\AppData\\Local\\agent-harness")).toBe(fixture("agent-harness.cmd"));
  });

  it("gives the line that puts the shim's folder on the path: an export for a shell profile, a user Path change in PowerShell", () => {
    expect(pathLine("sh", "/home/david/.local/state/agent-harness/bin")).toBe('export PATH="/home/david/.local/state/agent-harness/bin:$PATH"');
    expect(pathLine("sh", '/Users/d "q" $x`y`\\/bin')).toBe('export PATH="/Users/d \\"q\\" \\$x\\`y\\`\\\\/bin:$PATH"');
    // Through the registry, so the user Path keeps its type (REG_EXPAND_SZ) and the variables its entries name.
    expect(pathLine("cmd", "C:\\Users\\O'Neil\\AppData\\Local\\agent-harness\\bin")).toBe(
      "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); " +
        "$k.SetValue('Path', 'C:\\Users\\O''Neil\\AppData\\Local\\agent-harness\\bin;' + $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'), 'ExpandString')",
    );
  });
});

describe.runIf(posix)("the shim, run by sh", () => {
  const runShim = (dataDir: string, args: string[], env: Record<string, string> = {}) => {
    const path = join(dataDir, SHIM_DIRECTORY, SHIM_FILES.sh);
    mkdirSync(join(dataDir, SHIM_DIRECTORY), { recursive: true });
    writeFileSync(path, renderShim("sh", dataDir));
    const result = spawnSync("/bin/sh", [path, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it("runs the active version's agent-harness with its own Node and the arguments as given, not the launcher's version", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    installVersion(dataDir, "0.6.0-beta.1", ECHO_CHILD);
    writeServiceState(dataDir, state("0.6.0-beta.1", "0.5.0"));
    const ran = runShim(dataDir, ["tui", "--cwd", "a dir with 'quotes' and $HOME", ""]);
    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ version: "0.6.0-beta.1", args: ["tui", "--cwd", "a dir with 'quotes' and $HOME", ""] });
  });

  it("exits with the version's exit code", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    writeServiceState(dataDir, state("0.5.0"));
    expect(runShim(dataDir, ["status"], { ECHO_EXIT: "3" }).code).toBe(3);
  });

  it("reads a service state written on one line too", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    writeFileSync(join(dataDir, "service-state.json"), JSON.stringify(state("0.5.0")));
    expect(JSON.parse(runShim(dataDir, ["--version"]).stdout)).toMatchObject({ version: "0.5.0" });
  });

  it("exits 1 saying why when there is no service state, or its active version is not complete", () => {
    const missing = tempDataDir();
    expect(runShim(missing, ["tui"])).toEqual({
      code: 1,
      stdout: "",
      stderr: `agent-harness: the service state in ${missing} names no active version; \`agent-harness service install\` writes it.\n`,
    });

    const incomplete = tempDataDir();
    installVersion(incomplete, "0.5.0", ECHO_CHILD);
    rmSync(join(versionDirectory(incomplete, "0.5.0"), VERSION_SENTINEL));
    writeServiceState(incomplete, state("0.5.0"));
    expect(runShim(incomplete, ["tui"])).toEqual({
      code: 1,
      stdout: "",
      stderr: `agent-harness: the active version 0.5.0 is not complete in ${incomplete}/versions.\n`,
    });
  });
});
