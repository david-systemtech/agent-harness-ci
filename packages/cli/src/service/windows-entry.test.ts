import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test/service-helpers.js";
import { HANDOVER_FILE, HANDOVER_STARTS_FILE, writeHandover } from "../launch/handover.js";
import { LAUNCHER_VERSION_FILE } from "../launch/launcher-version.js";
import { VERSION_CLI_ENTRY, VERSION_SENTINEL, versionDirectory, versionNode } from "../launch/versions.js";
import { SERVICE_LOG_VARIABLE } from "../launch/verb.js";
import { LAUNCHER_ENTRY_FILES, renderLauncherEntry } from "./entry.js";
import { nameVersion } from "./layout.js";

// These tests need the real cmd.exe and findstr on the hosted Windows smoke runner.
let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const harness = () => {
  const dir = makeTempDir();
  cleanups.push(dir.remove);
  const dataDir = join(dir.path, "data & (entry)");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  for (const version of ["0.4.0", "0.5.0"]) {
    const folder = versionDirectory(dataDir, version);
    const node = join(folder, ...versionNode("win32"));
    const cli = join(folder, ...VERSION_CLI_ENTRY);
    mkdirSync(dirname(node), { recursive: true });
    mkdirSync(dirname(cli), { recursive: true });
    copyFileSync(process.execPath, node);
    // The launcher writes the service log the entry names in its variable (#1712).
    writeFileSync(
      cli,
      `require("node:fs").appendFileSync(process.env.${SERVICE_LOG_VARIABLE}, JSON.stringify({ version: "${version}", args: process.argv.slice(2) }) + "\\n");\n`,
    );
    writeFileSync(join(folder, VERSION_SENTINEL), "");
  }
  writeFileSync(join(dataDir, LAUNCHER_ENTRY_FILES.cmd), renderLauncherEntry("cmd", { dataDir, port: 7433 }));
  const write = (file: string, text: string) => writeFileSync(join(dataDir, file), text);
  const read = (file: string) => readFileSync(join(dataDir, file), "utf8");
  const run = () => {
    write("logs/service.log", "");
    const ran = spawnSync("cmd.exe", ["/d", "/c", ".\\launcher-entry.cmd"], { cwd: dataDir, encoding: "utf8", timeout: 120_000 });
    expect(ran.error).toBeUndefined();
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe("");
    return read("logs/service.log");
  };
  return { dataDir, write, read, run };
};

describe.runIf(process.platform === "win32")("the launcher entry under real cmd.exe and findstr", () => {
  it.each(["\n", "\r\n"])("reaches the launcher for a version file ending in %j", (end) => {
    const h = harness();
    h.write(LAUNCHER_VERSION_FILE, `0.5.0${end}`);
    expect(JSON.parse(h.run())).toEqual({ version: "0.5.0", args: ["launch", "--data-dir", h.dataDir, "--port", "7433"] });
  }, 120_000);

  it("reaches the launcher using the files the Windows install and handover writers produce", () => {
    const h = harness();
    nameVersion(h.dataDir, "0.5.0");
    writeHandover(h.dataDir, { fromVersion: "0.4.0", toVersion: "0.5.0" });
    expect(JSON.parse(h.run())).toMatchObject({ version: "0.5.0" });
    expect(h.read(LAUNCHER_VERSION_FILE)).toBe("0.5.0\r\n");
    expect(h.read(HANDOVER_FILE)).toBe("0.4.0\r\n0.5.0\r\n");
    expect(h.read(HANDOVER_STARTS_FILE)).toBe("1\r\n");
  }, 120_000);

  it.each(["\n", "\r\n"])("counts a handover and falls back with CRLF writes when its files end in %j", (end) => {
    const h = harness();
    h.write(LAUNCHER_VERSION_FILE, `0.5.0${end}`);
    h.write(HANDOVER_FILE, `0.4.0${end}0.5.0${end}`);
    h.write(HANDOVER_STARTS_FILE, `2${end}`);
    expect(JSON.parse(h.run())).toMatchObject({ version: "0.5.0" });
    expect(h.read(HANDOVER_STARTS_FILE)).toBe("3\r\n");
    const log = h.run();
    expect(log).toContain("the launcher of 0.4.0 starts again.");
    expect(JSON.parse(log.trim().split(/\r?\n/).at(-1) ?? "")).toMatchObject({ version: "0.4.0" });
    expect(h.read(LAUNCHER_VERSION_FILE)).toBe("0.4.0\r\n");
  }, 120_000);

  it.each(["\n", "\r\n"])("refuses forbidden characters before expanding a version with %j lines", (end) => {
    for (const value of ['0.5.0" & echo hostile', "0.5.0 & echo hostile", "0.5.0|echo hostile", "%PATH%", "../0.5.0", "0.5.0 extra", "0.5.0\t", `0.5.0${end}& echo hostile`]) {
      const h = harness();
      h.write(LAUNCHER_VERSION_FILE, `${value}${end}`);
      const log = h.run();
      expect(log, value).toContain("names no version, so no launcher starts");
      expect(log, value).not.toContain('"version":');
      expect(log, value).not.toContain("hostile");
    }
  }, 120_000);

  it.each(["\n", "\r\n"])("ignores unsafe handovers and resets an unsafe counter with %j lines", (end) => {
    const h = harness();
    h.write(LAUNCHER_VERSION_FILE, `0.5.0${end}`);
    h.write(HANDOVER_FILE, `0.4.0" & echo hostile${end}0.5.0${end}`);
    h.write(HANDOVER_STARTS_FILE, `3${end}`);
    expect(JSON.parse(h.run())).toMatchObject({ version: "0.5.0" });
    expect(h.read(HANDOVER_STARTS_FILE)).toBe(`3${end}`);
    h.write(HANDOVER_FILE, `0.4.0${end}0.5.0${end}`);
    h.write(HANDOVER_STARTS_FILE, `3 & echo hostile${end}`);
    expect(JSON.parse(h.run())).toMatchObject({ version: "0.5.0" });
    expect(h.read(HANDOVER_STARTS_FILE)).toBe("1\r\n");
  }, 120_000);
});
