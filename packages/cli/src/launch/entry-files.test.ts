import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test/service-helpers.js";
import { HANDOVER_FILE, readHandover, writeHandover } from "./handover.js";
import { LAUNCHER_VERSION_FILE, writeLauncherVersion } from "./launcher-version.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

describe("the files the launcher entry reads", () => {
  it.each(["win32", "linux", "darwin"] as const)("writes the launcher version with the line ending for %s", (platform) => {
    const dir = makeTempDir();
    cleanups.push(dir.remove);
    writeLauncherVersion(dir.path, "0.5.0", undefined, platform);
    expect(readFileSync(join(dir.path, LAUNCHER_VERSION_FILE), "utf8")).toBe(platform === "win32" ? "0.5.0\r\n" : "0.5.0\n");
  });
  it.each(["win32", "linux", "darwin"] as const)("writes a readable handover with the line ending for %s", (platform) => {
    const dir = makeTempDir();
    cleanups.push(dir.remove);
    writeHandover(dir.path, { fromVersion: "0.4.0", toVersion: "0.5.0" }, undefined, platform);
    expect(readFileSync(join(dir.path, HANDOVER_FILE), "utf8")).toBe(platform === "win32" ? "0.4.0\r\n0.5.0\r\n" : "0.4.0\n0.5.0\n");
    expect(readHandover(dir.path)).toEqual({ fromVersion: "0.4.0", toVersion: "0.5.0" });
  });

});
