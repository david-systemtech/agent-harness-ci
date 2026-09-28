import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installVersion } from "../../test/launcher-fixtures.js";
import { makeTempDir } from "../../test/service-helpers.js";
import { LAUNCHER_VERSION_FILE } from "../launch/launcher-version.js";
import { VERSION_SENTINEL, versionDirectory } from "../launch/versions.js";
import { LAUNCHER_ENTRY_FILES, renderLauncherEntry } from "./entry.js";

/**
 * The launcher entry (#338): the stable script the service definition runs,
 * which starts the launcher of the version the launcher version file names.
 * Both kinds render from fixtures; the `sh` one also runs here, against a
 * data directory whose versions are the echo child.
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

describe("the launcher entry", () => {
  it("is launcher-entry.sh run by sh on macOS and Linux, and launcher-entry.cmd on Windows", () => {
    expect(LAUNCHER_ENTRY_FILES).toEqual({ sh: "launcher-entry.sh", cmd: "launcher-entry.cmd" });
  });

  it("renders for sh as the fixture: the launcher version file's version, its own Node, launch with the data directory, port and name", () => {
    expect(renderLauncherEntry("sh", { dataDir: "/home/david/.local/state/agent-harness", port: 7433, name: "David's desk" })).toBe(
      fixture("launcher-entry.sh"),
    );
  });

  it("renders for cmd as the fixture, with CRLF lines: the same, restarting a launcher that exits non-zero, into the service log", () => {
    expect(renderLauncherEntry("cmd", { dataDir: "C:\\Users\\david\\AppData\\Local\\agent-harness", port: 7433, name: "David's desk" })).toBe(
      fixture("launcher-entry.cmd"),
    );
  });

  it("ends the cmd line that runs the launcher in its own exits, so install can replace the file while cmd waits on that line", () => {
    // cmd reads a batch file by offset, line after line: after the launcher returns it reads nothing more by offset,
    // only a label scan (goto), which finds the label in whichever file is there by then.
    const lines = renderLauncherEntry("cmd", { dataDir: "C:\\data", port: 7433 }).split("\r\n");
    const launch = lines.findIndex((line) => line.includes(" launch "));
    expect(lines[launch]).toMatch(/ >>"%LOG%" 2>&1 && exit \/b 0 \|\| goto restart$/);
    expect(lines[launch + 1]).toBe(":restart");
  });

  it("refuses in the cmd entry a launcher version file with a line that is not a version, without expanding that line", () => {
    const lines = renderLauncherEntry("cmd", { dataDir: "C:\\data", port: 7433 }).split("\r\n");
    const check = lines.indexOf('if exist "%DATA_DIR%\\launcher-version" findstr /r /v /x "[0-9A-Za-z.+-]*" "%DATA_DIR%\\launcher-version" >nul && goto no_version');
    expect(check).toBeGreaterThan(lines.indexOf(":start"));
    expect(check).toBeLessThan(lines.findIndex((line) => line.includes("for /f")));
  });

  it("passes no --name when it was given none, so an existing environment keeps its own and a new one takes the hostname", () => {
    for (const kind of ["sh", "cmd"] as const) {
      const entry = renderLauncherEntry(kind, { dataDir: "/data", port: 7500 });
      expect(entry, kind).toContain("launch --data-dir ");
      expect(entry, kind).toContain(" --port 7500");
      expect(entry, kind).not.toContain("--name");
    }
  });

  it("writes a name and a data directory into a cmd entry so that cmd reads every character literally", () => {
    const entry = renderLauncherEntry("cmd", { dataDir: "C:\\100% & (data)", port: 7433, name: 'Say "hi" & 50% <off> ^ (now) | !' });
    const lines = entry.split("\r\n");
    expect(lines).toContain('set "DATA_DIR=C:\\100%% & (data)"');
    const launch = lines.find((line) => line.includes(" launch "));
    expect(launch).toContain(
      '--data-dir ^"C:\\100%% ^& ^(data^)^" --port 7433 --name ^"Say \\^"hi\\^" ^& 50%% ^<off^> ^^ ^(now^) ^| ^!^" >>"%LOG%" 2>&1',
    );
  });

  it("refuses a name or data directory holding a line break, which no script line can carry", () => {
    expect(() => renderLauncherEntry("sh", { dataDir: "/data", port: 7433, name: "two\nlines" })).toThrow(/line break/);
    expect(() => renderLauncherEntry("cmd", { dataDir: "C:\\da\rta", port: 7433 })).toThrow(/line break/);
  });
});

describe.runIf(posix)("the launcher entry, run by sh", () => {
  /** Runs the sh entry rendered for `dataDir` and answers its exit code and output. */
  const runEntry = (dataDir: string, name?: string) => {
    const path = join(dataDir, LAUNCHER_ENTRY_FILES.sh);
    writeFileSync(path, renderLauncherEntry("sh", { dataDir, port: 7433, ...(name !== undefined && { name }) }));
    const result = spawnSync("/bin/sh", [path], { encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it("runs launch in the version the launcher version file names, with its own Node, and nothing of the active version", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    installVersion(dataDir, "0.6.0", ECHO_CHILD);
    writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "0.5.0\n");
    const ran = runEntry(dataDir, "It's 'quoted' $HOME");
    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      version: "0.5.0",
      args: ["launch", "--data-dir", dataDir, "--port", "7433", "--name", "It's 'quoted' $HOME"],
    });
  });

  it("exits with the launcher's code, which the service manager restarts on when it is not 0", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "0.5.0");
    const path = join(dataDir, LAUNCHER_ENTRY_FILES.sh);
    writeFileSync(path, renderLauncherEntry("sh", { dataDir, port: 7433 }));
    expect(spawnSync("/bin/sh", [path], { env: { ...process.env, ECHO_EXIT: "75" } }).status).toBe(75);
  });

  it("starts nothing and exits 0, saying why on standard error, when the launcher version file is missing or names no version", () => {
    for (const content of [undefined, "", "../0.5.0\n", "0.5.0 extra\n"]) {
      const dataDir = tempDataDir();
      installVersion(dataDir, "0.5.0", ECHO_CHILD);
      if (content !== undefined) writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), content);
      const ran = runEntry(dataDir);
      expect(ran, String(content)).toMatchObject({ code: 0, stdout: "" });
      expect(ran.stderr, String(content)).toBe(
        `launcher entry: ${dataDir}/launcher-version names no version, so no launcher starts; \`agent-harness service install\` writes it.\n`,
      );
    }
  });

  it("starts nothing and exits 0 when the version it names is not complete", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    rmSync(join(versionDirectory(dataDir, "0.5.0"), VERSION_SENTINEL));
    writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "0.5.0\n");
    const ran = runEntry(dataDir);
    expect(ran).toMatchObject({ code: 0, stdout: "" });
    expect(ran.stderr).toContain("launcher entry: 0.5.0 is not complete in");
  });
});
