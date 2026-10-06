import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installVersion } from "../../test/launcher-fixtures.js";
import { makeTempDir } from "../../test/service-helpers.js";
import { HANDOVER_FILE, HANDOVER_STARTS_FILE } from "../launch/handover.js";
import { RELAUNCH_EXIT_CODE } from "../launch/launcher.js";
import { LAUNCHER_VERSION_FILE } from "../launch/launcher-version.js";
import { VERSION_SENTINEL, versionDirectory } from "../launch/versions.js";
import { SERVICE_LOG_VARIABLE, UNLOGGED_EXIT_VARIABLE } from "../launch/verb.js";
import { LAUNCHER_ENTRY_FILES, LOG_LINE_TRIES, renderLauncherEntry } from "./entry.js";

/**
 * The launcher entry (#338): the stable script the service definition runs,
 * which starts the launcher of the version the launcher version file names.
 * Both kinds render from fixtures; the `sh` one also runs here, against a
 * data directory whose versions are the echo child.
 */

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/service/${name}`, import.meta.url), "utf8");
const ECHO_CHILD = fileURLToPath(new URL("../../test/echo-child.ts", import.meta.url));
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
    expect(lines[launch]).toMatch(/ --port 7433 && exit \/b 0 \|\| goto restart$/);
    expect(lines[launch + 1]).toBe(":restart");
  });

  it("names the service log for the launcher to write rather than redirecting the launcher into it, which cmd holds for itself alone (#1712)", () => {
    const lines = renderLauncherEntry("cmd", { dataDir: "C:\\data", port: 7433 }).split("\r\n");
    expect(lines).toContain(`set "${SERVICE_LOG_VARIABLE}=%LOG%"`);
    expect(lines.findIndex((line) => line.startsWith(`set "${SERVICE_LOG_VARIABLE}=`))).toBeGreaterThan(lines.findIndex((line) => line.startsWith('set "LOG=')));
    const launch = lines.find((line) => line.includes(" launch ")) ?? "";
    expect(launch).not.toContain(">");
  });

  it("tries its restart line again, a second apart and a bounded number of times, then leaves its code for the next launcher to write (#1712)", () => {
    const lines = renderLauncherEntry("cmd", { dataDir: "C:\\data", port: 7433 }).split("\r\n");
    const restart = lines.indexOf(":restart");
    expect(lines.slice(restart, restart + 9)).toEqual([
      ":restart",
      'set "CODE=%ERRORLEVEL%"',
      'set "TRIES=0"',
      `set "${UNLOGGED_EXIT_VARIABLE}="`,
      ":restart_line",
      'set /a "TRIES+=1"',
      `(>>"%LOG%" echo launcher entry: the launcher exited with code %CODE%, so it starts again in 5 s.) 2>nul || (if %TRIES% LSS ${LOG_LINE_TRIES} (ping -n 2 127.0.0.1 >nul & goto restart_line) else set "${UNLOGGED_EXIT_VARIABLE}=%CODE%")`,
      "ping -n 6 127.0.0.1 >nul",
      "goto start",
    ]);
  });

  it("writes the launcher version file and the start counter by a rename in both kinds, so a stop mid-write leaves the old file or the new", () => {
    const sh = renderLauncherEntry("sh", { dataDir: "/data", port: 7433 }).split("\n");
    const cmd = renderLauncherEntry("cmd", { dataDir: "C:\\data", port: 7433 }).split("\r\n");
    for (const file of ["launcher-version", "launcher-handover-starts"]) {
      expect(sh.filter((line) => line.includes(`> "$data_dir/${file}"`)), file).toEqual([]);
      expect(sh.some((line) => line.includes(`mv -f "$data_dir/.${file}.tmp" "$data_dir/${file}"`)), file).toBe(true);
      expect(cmd.filter((line) => line.startsWith(`>"%DATA_DIR%\\${file}"`)), file).toEqual([]);
      expect(cmd, file).toContain(`move /y "%DATA_DIR%\\.${file}.tmp" "%DATA_DIR%\\${file}" >nul`);
    }
  });

  it("refuses in the cmd entry a launcher version file with a line that is not a version, without expanding that line", () => {
    const lines = renderLauncherEntry("cmd", { dataDir: "C:\\data", port: 7433 }).split("\r\n");
    const check = lines.indexOf('if exist "%DATA_DIR%\\launcher-version" findstr /r "[^0-9A-Za-z.+-]" "%DATA_DIR%\\launcher-version" >nul && goto no_version');
    expect(check).toBeGreaterThan(lines.indexOf(":start"));
    expect(check).toBeLessThan(lines.findIndex((line) => line.includes("for /f")));
  });

  it("passes no --name when it was given none, so an existing environment keeps its own and a new one takes the hostname's first label", () => {
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
      '--data-dir ^"C:\\100%% ^& ^(data^)^" --port 7433 --name ^"Say \\^"hi\\^" ^& 50%% ^<off^> ^^ ^(now^) ^| ^!^" && exit /b 0',
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

  it("exits with the launcher's code, which the service manager restarts on when it is not 0, as the relaunch code of a handover is", () => {
    const dataDir = tempDataDir();
    installVersion(dataDir, "0.5.0", ECHO_CHILD);
    writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "0.5.0");
    const path = join(dataDir, LAUNCHER_ENTRY_FILES.sh);
    writeFileSync(path, renderLauncherEntry("sh", { dataDir, port: 7433 }));
    expect(spawnSync("/bin/sh", [path], { env: { ...process.env, ECHO_EXIT: String(RELAUNCH_EXIT_CODE) } }).status).toBe(RELAUNCH_EXIT_CODE);
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

  describe("after a handover", () => {
    /** A data directory whose launcher version file names 0.5.0's launcher, handed over to by 0.4.0's. */
    const handedOver = (record = "0.4.0\n0.5.0\n"): string => {
      const dataDir = tempDataDir();
      installVersion(dataDir, "0.4.0", ECHO_CHILD);
      installVersion(dataDir, "0.5.0", ECHO_CHILD);
      writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "0.5.0\n");
      writeFileSync(join(dataDir, HANDOVER_FILE), record);
      return dataDir;
    };
    const read = (dataDir: string, file: string): string | undefined => (existsSync(join(dataDir, file)) ? readFileSync(join(dataDir, file), "utf8") : undefined);

    it("counts each start of the launcher handed over to, and once three went unconfirmed names the launcher that handed over again and starts it", () => {
      const dataDir = handedOver();
      for (const count of [1, 2, 3]) {
        const ran = runEntry(dataDir);
        expect(ran, `start ${count}`).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(ran.stdout)).toMatchObject({ version: "0.5.0" });
        expect(read(dataDir, HANDOVER_STARTS_FILE)).toBe(`${count}\n`);
      }
      const fourth = runEntry(dataDir);
      expect(fourth.code).toBe(0);
      expect(JSON.parse(fourth.stdout)).toMatchObject({ version: "0.4.0", args: ["launch", "--data-dir", dataDir, "--port", "7433"] });
      expect(fourth.stderr).toBe(
        "launcher entry: the launcher of 0.5.0 was started 3 times without confirming that its child passed the gate, so the launcher of 0.4.0 starts again.\n",
      );
      expect(read(dataDir, LAUNCHER_VERSION_FILE)).toBe("0.4.0\n");
      // The launcher that handed over finds the record naming itself, and clears it with the counter.
      expect(read(dataDir, HANDOVER_FILE)).toBe("0.4.0\n0.5.0\n");
      expect(read(dataDir, HANDOVER_STARTS_FILE)).toBe("3\n");
      expect(readdirSync(dataDir).filter((name) => name.startsWith("."))).toEqual([]);
    });

    it("counts again from one once the launcher handed over to confirmed and removed its files", () => {
      const dataDir = handedOver();
      runEntry(dataDir);
      runEntry(dataDir);
      rmSync(join(dataDir, HANDOVER_FILE));
      rmSync(join(dataDir, HANDOVER_STARTS_FILE));
      for (let start = 0; start < 4; start++) expect(JSON.parse(runEntry(dataDir).stdout)).toMatchObject({ version: "0.5.0" });
      expect(read(dataDir, HANDOVER_STARTS_FILE)).toBeUndefined();
    });

    it("counts nothing for a handover record naming another launcher than the one it starts, or naming no version it hands over from", () => {
      for (const record of ["0.4.0\n0.6.0\n", "../0.4.0\n0.5.0\n", "0.5.0\n"]) {
        const dataDir = handedOver(record);
        writeFileSync(join(dataDir, HANDOVER_STARTS_FILE), "3\n");
        expect(JSON.parse(runEntry(dataDir).stdout), record).toMatchObject({ version: "0.5.0" });
        expect(read(dataDir, HANDOVER_STARTS_FILE), record).toBe("3\n");
        expect(read(dataDir, LAUNCHER_VERSION_FILE), record).toBe("0.5.0\n");
      }
    });

    it("takes a start counter that is not a number as none", () => {
      const dataDir = handedOver();
      writeFileSync(join(dataDir, HANDOVER_STARTS_FILE), "three\n");
      expect(JSON.parse(runEntry(dataDir).stdout)).toMatchObject({ version: "0.5.0" });
      expect(read(dataDir, HANDOVER_STARTS_FILE)).toBe("1\n");
    });
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
