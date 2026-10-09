import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InstallDependencies } from "./stage.js";
import { BuildError, type ArtefactTarget } from "./targets.js";

/**
 * The release build's dependency install (#356): pnpm, from the workspace's
 * own lockfile, so every artefact carries exactly the versions CI tested, in a
 * staged workspace holding only the packages the CLI runs. pnpm's hoisted
 * linker lays out a flat `node_modules` with no link in it but its `.bin` and
 * the workspace packages', which the build replaces; its supported
 * architectures pick the platform's own optional packages (the SDK's Claude
 * binary), whichever platform the build runs on; and install scripts run only
 * for the build's own platform, where `node-pty` compiles when its npm package
 * has no prebuild.
 */

const run = promisify(execFile);

/**
 * The lockfile `text` with only the importers `keep` names (`.` and the
 * packages' folders), so a frozen install of the staged workspace installs
 * what those packages need and nothing the others do: pnpm's hoisted linker
 * installs every importer the lockfile holds, whatever the workspace has. It
 * reads the lockfile's own layout (version 9): an importer is a key indented
 * two spaces under `importers:`. A package kept that the lockfile has no
 * importer for is a `BuildError`.
 */
export const trimLockfile = (text: string, keep: readonly string[]): string => {
  const kept: string[] = [];
  const found = new Set<string>();
  let section = "";
  let dropping = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.split(":", 1)[0] ?? "";
      dropping = false;
    } else if (section === "importers" && /^ {2}\S/.test(line)) {
      const importer = line.trim().replace(/:.*$/, "").replace(/^'(.*)'$/, "$1");
      dropping = !keep.includes(importer);
      if (!dropping) found.add(importer);
    }
    if (!dropping) kept.push(line);
  }
  const missing = keep.filter((importer) => !found.has(importer));
  if (missing.length > 0) throw new BuildError(`pnpm-lock.yaml has no importer for ${missing.join(", ")}: run pnpm install and commit the lockfile.`);
  return kept.join("\n");
};

/** What the staged workspace's `pnpm-workspace.yaml` adds to the workspace's own for `target`. */
export const stagedSettings = (target: ArtefactTarget, runScripts: boolean): string =>
  [
    "",
    `# The release build's install of the ${target.platform} artefact (packages/cli/scripts/release/pnpm.ts).`,
    "nodeLinker: hoisted",
    // Copies, never links into the store: the build changes files in place (node-pty's helper's mode).
    "packageImportMethod: copy",
    // The cache of built packages is keyed by the platform pnpm runs on: another platform's must never take it.
    ...(runScripts ? [] : ["sideEffectsCache: false"]),
    "supportedArchitectures:",
    `  os: [${target.os}]`,
    `  cpu: [${target.cpu}]`,
    ...(target.libc === undefined ? [] : [`  libc: [${target.libc}]`]),
    "",
  ].join("\n");

/** The preset install: the staged workspace written into `workspace`, then `pnpm install --frozen-lockfile --prod` there, from the workspace's own store. */
export const pnpmInstall: InstallDependencies = async ({ repoRoot, workspace, packages, target, runScripts }) => {
  mkdirSync(workspace, { recursive: true });
  copyFileSync(join(repoRoot, "package.json"), join(workspace, "package.json"));
  // Frozen installs resolve patchedDependencies relative to the staged workspace.
  if (existsSync(join(repoRoot, "patches"))) cpSync(join(repoRoot, "patches"), join(workspace, "patches"), { recursive: true });
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8") + stagedSettings(target, runScripts));
  const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  writeFileSync(join(workspace, "pnpm-lock.yaml"), trimLockfile(lockfile, [".", ...packages.map((each) => each.directory)]));
  for (const each of packages) {
    mkdirSync(join(workspace, each.directory), { recursive: true });
    copyFileSync(join(repoRoot, each.directory, "package.json"), join(workspace, each.directory, "package.json"));
  }
  const store = (await run("pnpm", ["store", "path"], { cwd: repoRoot })).stdout.trim();
  const args = ["install", "--frozen-lockfile", "--prod", "--prefer-offline", "--store-dir", store, ...(runScripts ? [] : ["--ignore-scripts"])];
  await run("pnpm", args, { cwd: workspace, maxBuffer: 64 * 1024 * 1024 });
};
