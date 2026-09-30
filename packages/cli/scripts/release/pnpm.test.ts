import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stagedSettings, trimLockfile } from "./pnpm.js";
import { runtimePackages } from "./stage.js";
import { artefactTargets } from "./targets.js";

/**
 * The release build's dependency install (#356): a frozen pnpm install of a
 * staged workspace, whose lockfile keeps only the importers of the packages
 * the CLI runs (pnpm's hoisted linker installs every importer a lockfile
 * holds) and whose settings pick the target's platform. The install itself
 * runs only in a real build; these check what it is given.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

const LOCKFILE = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      vitest:",
  "        specifier: ^4.1.11",
  "        version: 4.1.11",
  "",
  "  packages/cli:",
  "    dependencies:",
  "      uqr:",
  "        specifier: ^0.1.3",
  "        version: 0.1.3",
  "",
  "  packages/gui:",
  "    dependencies:",
  "      react:",
  "        specifier: 19.3.0",
  "        version: 19.3.0",
  "",
  "  'packages/odd name':",
  "    dependencies: {}",
  "",
  "packages:",
  "",
  "  uqr@0.1.3:",
  "    resolution: {integrity: sha512-fake}",
  "",
].join("\n");

describe("the staged workspace's lockfile", () => {
  it("keeps the importers named, and every other section whole, and drops the other importers", () => {
    const trimmed = trimLockfile(LOCKFILE, [".", "packages/cli", "packages/odd name"]);
    expect(trimmed).toBe(LOCKFILE.replace("  packages/gui:\n    dependencies:\n      react:\n        specifier: 19.3.0\n        version: 19.3.0\n\n", ""));
  });

  it("refuses a package the lockfile has no importer for", () => {
    expect(() => trimLockfile(LOCKFILE, [".", "packages/cli", "packages/tui"])).toThrow(/pnpm-lock.yaml has no importer for packages\/tui/);
  });

  it("keeps, of the workspace's own lockfile, an importer for every package the CLI runs and none for the GUI, the desktop or the browser package", () => {
    const packages = runtimePackages(repoRoot).map((each) => each.directory);
    const trimmed = trimLockfile(readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8"), [".", ...packages]);
    const importers = [...trimmed.matchAll(/^ {2}(\S[^:]*):/gm)].map((match) => match[1]).filter((key) => key === "." || key?.startsWith("packages/"));
    expect(importers.sort()).toEqual([".", ...packages].sort());
    expect(packages).toContain("packages/environment");
    expect(packages).not.toContain("packages/gui");
  });
});

describe("the staged workspace's settings", () => {
  const [linux, darwin] = artefactTargets(["linux-x64", "darwin-arm64"]);

  it("install hoisted copies for the target's OS and CPU, and glibc on Linux, whatever platform pnpm runs on", () => {
    expect(stagedSettings(darwin!, false)).toContain("nodeLinker: hoisted\npackageImportMethod: copy\nsideEffectsCache: false\nsupportedArchitectures:\n  os: [darwin]\n  cpu: [arm64]\n");
    expect(stagedSettings(linux!, true)).toContain("supportedArchitectures:\n  os: [linux]\n  cpu: [x64]\n  libc: [glibc]\n");
  });

  it("keep pnpm's cache of built packages only for the build's own platform, which that cache is keyed by", () => {
    expect(stagedSettings(linux!, true)).not.toContain("sideEffectsCache");
    expect(stagedSettings(linux!, false)).toContain("sideEffectsCache: false");
  });
});
