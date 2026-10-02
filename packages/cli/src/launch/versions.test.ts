import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeVersion } from "./prune.js";
import { completeVersions, isComplete, VERSION_SENTINEL, versionCommand, versionDirectory, VERSIONS_DIRECTORY } from "./versions.js";

/**
 * The versions directory (launcher-update spec, "Versions and the launcher"):
 * one folder per installed version, named by the version, which counts only
 * once its sentinel is written last.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const dataDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-versions-"));
  dirs.push(dir);
  return dir;
};

describe("the versions directory", () => {
  it("is the data directory's versions folder, a version's folder named by the version", () => {
    expect(VERSIONS_DIRECTORY).toBe("versions");
    expect(versionDirectory("/data", "0.5.0")).toBe(join("/data", "versions", "0.5.0"));
  });

  it("counts a version complete only once its folder holds the sentinel, and only a folder named by a version", () => {
    const dataDir = dataDirectory();
    for (const version of ["0.5.0", "0.10.0", "0.9.1-beta.2", "0.4.2", "latest"]) {
      mkdirSync(versionDirectory(dataDir, version), { recursive: true });
      if (version !== "0.4.2") writeFileSync(join(versionDirectory(dataDir, version), VERSION_SENTINEL), "");
    }
    writeFileSync(join(dataDir, VERSIONS_DIRECTORY, "0.6.0"), "a file, not a folder");
    expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.9.1-beta.2", "0.10.0"]);
  });

  it("counts nothing but a version complete, however a folder holding the sentinel is reached", () => {
    const dataDir = dataDirectory();
    mkdirSync(versionDirectory(dataDir, "0.5.0"), { recursive: true });
    writeFileSync(join(versionDirectory(dataDir, "0.5.0"), VERSION_SENTINEL), "");
    expect(isComplete(dataDir, "0.5.0")).toBe(true);
    for (const reached of ["../versions/0.5.0", "0.5.0/.", "latest/../0.5.0"]) expect(isComplete(dataDir, reached), reached).toBe(false);
  });

  it("prunes a version holding read-only artefact directories", () => {
    const dataDir = dataDirectory();
    const folder = versionDirectory(dataDir, "0.5.0");
    const nested = join(folder, "packages");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(folder, VERSION_SENTINEL), "");
    writeFileSync(join(nested, "entry.js"), "runtime");
    chmodSync(join(nested, "entry.js"), 0o400);
    chmodSync(nested, 0o500);
    try {
      removeVersion(dataDir, "0.5.0");
      expect(existsSync(folder)).toBe(false);
    } finally {
      if (existsSync(nested)) chmodSync(nested, 0o700);
    }
  });

  it("holds no complete version when it does not exist", () => {
    expect(completeVersions(dataDirectory())).toEqual([]);
  });
});

describe("a version's command", () => {
  it("runs the version's own Node runtime on its CLI's entry, as Node's archives lay the runtime out", () => {
    expect(versionCommand("/data/versions/0.5.0", "linux")).toEqual([
      join("/data/versions/0.5.0", "node", "bin", "node"),
      join("/data/versions/0.5.0", "packages", "cli", "dist", "main.js"),
    ]);
    expect(versionCommand("/data/versions/0.5.0", "darwin")[0]).toBe(join("/data/versions/0.5.0", "node", "bin", "node"));
    expect(versionCommand("/data/versions/0.5.0", "win32")[0]).toBe(join("/data/versions/0.5.0", "node", "node.exe"));
  });
});
