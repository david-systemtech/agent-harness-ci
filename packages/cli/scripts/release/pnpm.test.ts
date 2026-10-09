import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pnpmInstall, stagedSettings, trimLockfile } from "./pnpm.js";
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

  it("keeps, of the workspace's own lockfile, an importer for every shipped package, including the extension, and none for the GUI", () => {
    const packages = runtimePackages(repoRoot).map((each) => each.directory);
    const trimmed = trimLockfile(readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8"), [".", ...packages]);
    const importers = [...trimmed.matchAll(/^ {2}(\S[^:]*):/gm)].map((match) => match[1]).filter((key) => key === "." || key?.startsWith("packages/"));
    expect(importers.sort()).toEqual([".", ...packages].sort());
    expect(packages).toContain("packages/environment");
    expect(packages).toContain("packages/extension");
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

it.runIf(process.platform !== "win32")("carries dependency patches into the release's frozen production install", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-patches-"));
  const oldPath = process.env["PATH"];
  try {
    const repoRoot = join(scratch, "repo");
    const workspace = join(scratch, "stage");
    const bin = join(scratch, "bin");
    mkdirSync(join(repoRoot, "patches"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(repoRoot, "package.json"), "{}");
    writeFileSync(join(repoRoot, "pnpm-workspace.yaml"), "patchedDependencies:\n  node-pty@1.1.0: patches/node-pty@1.1.0.patch\n");
    writeFileSync(join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    writeFileSync(join(repoRoot, "patches/node-pty@1.1.0.patch"), "the Windows cleanup patch");
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh
if [ "$1" = store ]; then echo '${scratch}/store'; exit 0; fi
cat patches/node-pty@1.1.0.patch > installed-patch
`);
    chmodSync(join(bin, "pnpm"), 0o755);
    process.env["PATH"] = `${bin}:${oldPath}`;
    await pnpmInstall({ repoRoot, workspace, packages: [], target: artefactTargets(["win32-x64"])[0]!, runScripts: false });
    expect(readFileSync(join(workspace, "installed-patch"), "utf8")).toBe("the Windows cleanup patch");
    expect(readFileSync(join(workspace, "pnpm-workspace.yaml"), "utf8")).toContain("node-pty@1.1.0: patches/node-pty@1.1.0.patch");
  } finally {
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    rmSync(scratch, { recursive: true, force: true });
  }
});
