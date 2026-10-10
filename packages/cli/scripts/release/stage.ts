import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { ARTEFACT_CLI_ENTRY, artefactNode } from "@agent-harness/contracts/launcher";
import { placeNodeRuntime, type NodeArchive } from "./node-runtime.js";
import { BuildError, type ArtefactTarget } from "./targets.js";
import { installWindowsPtyBuild } from "./windows-pty.js";

/**
 * One platform's server artefact laid out in a folder (launcher-update spec,
 * "The release"; #356), as it unpacks: `node/` (its own Node runtime),
 * `packages/cli/` (the CLI, whose `dist/main.js` the launcher runs and whose
 * `package.json` declares the version and launcher protocol), `node_modules/`
 * (every other shipped workspace package, including the browser extension, under its name, and their
 * production dependencies for this platform), and `bin/` (the
 * `agent-harness` command). It holds no link, so the same layout unpacks from
 * a zip on Windows, and every package names the release's version.
 */

/** A workspace package the artefact carries: the CLI, the built browser extension, and their runtime workspace dependencies. */
export interface RuntimePackage {
  readonly name: string;
  /** Its folder, relative to the workspace's root: `packages/cli`. */
  readonly directory: string;
  /** The workspace packages it depends on, by name. */
  readonly workspaceDependencies: readonly string[];
}

/** What the dependency install is asked: the production dependencies of `packages`, for `target`, laid out in `workspace` as pnpm's hoisted linker lays them out. */
export interface DependencyRequest {
  readonly repoRoot: string;
  readonly workspace: string;
  readonly packages: readonly RuntimePackage[];
  readonly target: ArtefactTarget;
  /** Whether install scripts run: only for the platform the build runs on, where `node-pty` compiles for it. */
  readonly runScripts: boolean;
}

export type InstallDependencies = (request: DependencyRequest) => Promise<void>;

/** The CLI's folder in the workspace and in the artefact alike. */
const CLI_DIRECTORY = ARTEFACT_CLI_ENTRY.slice(0, 2).join("/");

interface Manifest {
  readonly name?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

/**
 * The shipped workspace packages, the CLI first: the CLI and the browser
 * extension, plus their transitive runtime workspace dependencies. The
 * extension is a runtime asset loaded by Chrome, so no CLI import reaches it.
 */
export const runtimePackages = (repoRoot: string): RuntimePackage[] => {
  const directories = new Map<string, string>();
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    const manifest = join(repoRoot, "packages", entry.name, "package.json");
    if (entry.isDirectory() && existsSync(manifest)) directories.set(String(readManifest(manifest).name), `packages/${entry.name}`);
  }
  const found: RuntimePackage[] = [];
  const queue = [PRODUCT_NAME, "@agent-harness/extension"];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const directory = directories.get(name);
    if (directory === undefined) throw new BuildError(`No workspace package is named ${name}.`);
    if (found.some((each) => each.name === name)) continue;
    const manifest = readManifest(join(repoRoot, directory, "package.json"));
    const specifiers = { ...manifest.dependencies, ...manifest.optionalDependencies };
    const workspaceDependencies = Object.keys(specifiers).filter((dependency) => specifiers[dependency]?.startsWith("workspace:"));
    found.push({ name, directory, workspaceDependencies });
    queue.push(...workspaceDependencies);
  }
  if (found[0]?.directory !== CLI_DIRECTORY) throw new BuildError(`The CLI, ${PRODUCT_NAME}, must be in ${CLI_DIRECTORY}, where the launcher runs it.`);
  return found;
};

/**
 * A package's `package.json` text with its version stamped `version`, and
 * nothing else changed: the CLI's keeps its `launcherProtocol`, which the
 * launcher reads beside the version.
 */
const stampManifest = (text: string, version: string): string =>
  `${JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), version }, null, 2)}\n`;

/** Removes `path`, whatever it is; nothing when it is not there. */
const remove = (path: string): void => rmSync(path, { recursive: true, force: true });

/** Removes `folder` when nothing is left in it. */
const removeIfEmpty = (folder: string): void => {
  if (existsSync(folder) && readdirSync(folder).length === 0) remove(folder);
};

/**
 * Turns what pnpm installed in `root` into the artefact's `node_modules` and
 * `packages/cli`: pnpm's own files and its `.bin` links go, each workspace
 * package takes its stamped `package.json` and its `dist` in place of its
 * links to the others, and every one but the CLI moves under its name into
 * `node_modules`, where the CLI and each other finds it. A dependency pnpm
 * could not hoist stays in the `node_modules` of the package it belongs to.
 */
const layOutPackages = (repoRoot: string, packages: readonly RuntimePackage[], version: string, root: string): void => {
  for (const entry of readdirSync(root)) if (entry !== "node_modules" && entry !== "packages") remove(join(root, entry));
  const modules = join(root, "node_modules");
  for (const entry of readdirSync(modules)) if (entry.startsWith(".")) remove(join(modules, entry));
  for (const each of packages) {
    const staged = join(root, each.directory);
    const own = join(staged, "node_modules");
    for (const dependency of [...each.workspaceDependencies, ".bin"]) {
      remove(join(own, dependency));
      removeIfEmpty(dirname(join(own, dependency)));
    }
    removeIfEmpty(own);
    const dist = join(repoRoot, each.directory, "dist");
    if (!existsSync(dist)) throw new BuildError(`${each.directory} has no dist: the build compiles the workspace before it stages an artefact.`);
    cpSync(dist, join(staged, "dist"), { recursive: true });
    writeFileSync(join(staged, "package.json"), stampManifest(readFileSync(join(repoRoot, each.directory, "package.json"), "utf8"), version));
    if (each.directory !== CLI_DIRECTORY) {
      mkdirSync(dirname(join(modules, each.name)), { recursive: true });
      renameSync(staged, join(modules, each.name));
    }
  }
};

/**
 * Keeps of `node-pty` what runs on `target`: its prebuild for the platform
 * (macOS; its npm package carries them), without the other
 * platforms' or the debug symbols, and with the helper macOS spawns through
 * made executable, which the npm package ships without its execute bit; or,
 * with no usable prebuild (Linux and patched Windows), the native build compiled on the
 * build's own runner, which is why a platform with no prebuild is built only
 * on a runner of that platform.
 */
const keepNodePty = (root: string, target: ArtefactTarget): void => {
  const pty = join(root, "node_modules", "node-pty");
  const prebuilds = join(pty, "prebuilds");
  const own = join(prebuilds, target.platform);
  if (target.os !== "win32" && existsSync(join(own, "pty.node"))) {
    remove(join(pty, "build"));
    for (const entry of readdirSync(prebuilds)) if (entry !== target.platform) remove(join(prebuilds, entry));
    for (const entry of readdirSync(own, { recursive: true, encoding: "utf8" })) if (entry.endsWith(".pdb")) remove(join(own, entry));
    if (existsSync(join(own, "spawn-helper"))) chmodSync(join(own, "spawn-helper"), 0o755);
  } else if (existsSync(join(pty, "build", "Release", "pty.node"))) {
    remove(prebuilds);
  } else {
    throw new BuildError(
      `node-pty has no prebuild for ${target.platform}, and it was not compiled for it: it compiles only on a runner of that platform, so build the ${target.platform} artefact on one.`,
    );
  }
};

/** Writes `bin/agent-harness` (`bin\agent-harness.cmd` on Windows), which runs the artefact's own Node on its CLI from wherever the artefact is. */
const writeCommand = (root: string, target: ArtefactTarget): void => {
  mkdirSync(join(root, "bin"), { recursive: true });
  const [node, entry] = [artefactNode(target.os), ARTEFACT_CLI_ENTRY];
  if (target.os === "win32") {
    const lines = [
      "@echo off",
      `rem ${PRODUCT_NAME}: this release's CLI on its own Node, from wherever the artefact is unpacked.`,
      `"%~dp0..\\${node.join("\\")}" "%~dp0..\\${entry.join("\\")}" %*`,
      "exit /b %ERRORLEVEL%",
    ];
    writeFileSync(join(root, "bin", `${PRODUCT_NAME}.cmd`), `${lines.join("\r\n")}\r\n`);
    return;
  }
  const lines = [
    "#!/bin/sh",
    `# ${PRODUCT_NAME}: this release's CLI on its own Node, from wherever the artefact is unpacked.`,
    "# The artefact is the folder above this script's, as the path it was run by names it.",
    'case $0 in */*) bin=${0%/*} ;; *) bin=. ;; esac',
    'root=$(cd -P -- "$bin/.." && pwd -P) || exit 1',
    `exec "$root/${node.join("/")}" "$root/${entry.join("/")}" "$@"`,
  ];
  writeFileSync(join(root, "bin", PRODUCT_NAME), `${lines.join("\n")}\n`, { mode: 0o755 });
};

/** Every link under `root`, relative to it. */
const linksUnder = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => lstatSync(join(root, path)).isSymbolicLink());

/**
 * Checks what only a wrong install would leave: a link (Windows' `tar`
 * cannot make one from a zip), no keychain prebuild on macOS or Windows,
 * or no Claude binary for the platform, which
 * the SDK ships as a package per platform that the install picks by the
 * target's OS and CPU.
 */
const checkArtefact = (root: string, target: ArtefactTarget): void => {
  const links = linksUnder(root);
  if (links.length > 0) throw new BuildError(`The ${target.platform} artefact holds links, which do not unpack everywhere: ${links.slice(0, 5).join(", ")}.`);
  if (target.os === "darwin" || target.os === "win32") {
    const platform = target.os === "win32" ? `${target.platform}-msvc` : target.platform;
    const prebuild = join(root, "node_modules", "@napi-rs", `keyring-${platform}`, `keyring.${platform}.node`);
    if (!existsSync(prebuild) || !statSync(prebuild).isFile()) throw new BuildError(`The ${target.platform} artefact has no keychain prebuild for its platform at ${prebuild}.`);
  }
  const claude = join(root, "node_modules", "@anthropic-ai", `claude-agent-sdk-${target.platform}`, target.os === "win32" ? "claude.exe" : "claude");
  if (!existsSync(claude)) throw new BuildError(`The ${target.platform} artefact has no Claude binary for its platform at ${claude}.`);
};

/** What one artefact is laid out from. */
export interface StageRequest {
  readonly repoRoot: string;
  readonly packages: readonly RuntimePackage[];
  readonly target: ArtefactTarget;
  readonly version: string;
  /** The folder the artefact is laid out in, which must not exist yet; its contents are the artefact's top. */
  readonly root: string;
  /** Whether the target is the platform the build runs on, where install scripts run. */
  readonly onHost: boolean;
  /** The repaired Windows native runtime supplied by this run's Windows runner. */
  readonly windowsPtyBuild?: string;
  readonly installDependencies: InstallDependencies;
  /** Node's archive for the target, downloaded and checked. */
  readonly node: { readonly file: string; readonly archive: NodeArchive };
}

/** Lays out `target`'s artefact in `root`, which must not exist yet (see the module's comment). */
export const stageArtefact = async (request: StageRequest): Promise<void> => {
  const { repoRoot, packages, target, version, root } = request;
  mkdirSync(root, { recursive: true });
  await request.installDependencies({ repoRoot, workspace: root, packages, target, runScripts: request.onHost });
  layOutPackages(repoRoot, packages, version, root);
  const web = join(repoRoot, "packages/gui/dist");
  const stamp = JSON.parse(readFileSync(join(web, "version.json"), "utf8")) as { version?: string };
  if (stamp.version !== version) throw new BuildError("The web bundle must match the server release version.");
  cpSync(web, join(root, "node_modules/@agent-harness/environment/dist/serve/web-client"), { recursive: true });
  if (target.os === "win32") {
    if (request.windowsPtyBuild !== undefined) {
      installWindowsPtyBuild(request.windowsPtyBuild, join(root, "node_modules/node-pty"));
    } else if (!request.onHost) {
      throw new BuildError("Cross-built Windows artefacts require --windows-pty-build from the same run's Windows runner; the upstream prebuild lacks the console ownership fix.");
    }
  }
  keepNodePty(root, target);
  await placeNodeRuntime(request.node.file, request.node.archive, target, root);
  writeCommand(root, target);
  checkArtefact(root, target);
};
