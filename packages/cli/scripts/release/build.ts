import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { RELEASE_MANIFEST_FILE, ReleaseImage, ReleaseManifest, type PreflightReport, type ReleaseAsset } from "@agent-harness/contracts";
import { packTarGz, packZip, writeSidecar } from "./archive.js";
import { checkOtherAssets, writeOtherAsset, type OtherAsset } from "./assets.js";
import { fetchDownload, fetchNodeArchive, NODE_RUNTIME, nodeArchive, type Download, type NodeRuntime } from "./node-runtime.js";
import { pnpmInstall } from "./pnpm.js";
import { verifyArtefact } from "./verify.js";
import { runtimePackages, stageArtefact, type InstallDependencies } from "./stage.js";
import { artefactTargets, BuildError, hostPlatform, versionOfTag, type ArtefactTarget } from "./targets.js";

/**
 * The release build (launcher-update spec, "The release"; #356): one run
 * assembles every platform's server artefact under #113's names, writes a
 * `.sha256` sidecar beside each, writes the release's other assets the
 * workflow names beside them (#358), and writes the release manifest,
 * `release.json`, from them all and from the image it is given. The version is
 * the tag's, stamped into every package. The artefact of the platform the
 * build runs on is unpacked and run there, with no Node on the path, and its
 * preflight report gives the manifest the release's identity.
 */

/** What a release is built from. */
export interface BuildOptions {
  /** The release's tag, `v<version>`. */
  readonly tag: string;
  /** The folder the assets are written to, which must be empty or not exist. */
  readonly out: string;
  /** The release's container image, its exact reference and digest, which the manifest names. */
  readonly image: ReleaseImage;
  /** The platforms to build, preset every platform a release publishes. */
  readonly platforms?: readonly string[];
  /** The same run's Windows x64 native payload, built from the pinned patched node-pty source. */
  readonly windowsPtyBuild?: string;
  /** The release's other assets, listed in the manifest after the artefacts in this order; preset none. */
  readonly assets?: readonly OtherAsset[];
}

/** What the build does that a test replaces; each has a preset, the real one. */
export interface BuildSeams {
  /** The workspace's root; preset: this checkout's. */
  readonly repoRoot?: string;
  /** The platform the build runs on; preset: this process's. */
  readonly host?: string;
  /** Where the build lays out its artefacts before packing them; preset: a fresh folder in the system's temporary folder. It is removed at the end. */
  readonly work?: string;
  /** Builds the CLI, its runtime packages, the bank validator and the extension to `dist`, stamping the extension with the release version. */
  readonly compile?: (repoRoot: string, version: string) => Promise<void>;
  /** Preset: pnpm, from the workspace's lockfile (`pnpm.ts`). */
  readonly installDependencies?: InstallDependencies;
  /** Preset: `NODE_RUNTIME`. */
  readonly nodeRuntime?: NodeRuntime;
  /** Preset: `fetch`. */
  readonly download?: Download;
  /** Unpacks the host's artefact and runs it, answering its preflight report; preset: `verifyArtefact`. */
  readonly verify?: (archive: string, target: ArtefactTarget, version: string) => Promise<PreflightReport>;
  /** Where the build says what it is doing; preset: standard output. */
  readonly log?: (line: string) => void;
}

const run = promisify(execFile);

/** The checkout this script is in: four folders above its own. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

const compileWorkspace = async (repoRoot: string, version: string): Promise<void> => {
  await run("pnpm", ["exec", "tsc", "-b", "packages/cli"], { cwd: repoRoot });
  await run("pnpm", ["--filter", "@agent-harness/contracts", "build-validator"], { cwd: repoRoot });
  await run("pnpm", ["--filter", "@agent-harness/extension", "build", "--version", version], { cwd: repoRoot });
  await run("pnpm", ["--filter", "@agent-harness/gui", "build"], { cwd: repoRoot, env: { ...process.env, HARNESS_VERSION: version } });
};

/** The artefact `target` packed at `path`, as the manifest lists it. */
const assetOf = (target: ArtefactTarget, path: string, sha256: string): ReleaseAsset => ({
  name: target.name,
  kind: "environment",
  platform: target.platform,
  format: target.format,
  size: statSync(path).size,
  sha256,
});

/**
 * Writes `release.json` into `out`, with its sidecar: the release's identity
 * from the host artefact's preflight `report`, its `assets` and its `image`,
 * read through the contracts' schema, so a manifest the schema refuses is
 * never written.
 */
const writeManifest = async (out: string, report: PreflightReport, assets: readonly ReleaseAsset[], image: ReleaseImage): Promise<void> => {
  const { version, protocolVersion, launcherProtocol, databaseSchemaVersion, bundledClaudeCodeVersion } = report;
  const manifest = ReleaseManifest.safeParse({ version, protocolVersion, launcherProtocol, databaseSchemaVersion, bundledClaudeCodeVersion, assets, image });
  if (!manifest.success) throw new BuildError(`The release manifest does not match its schema: ${manifest.error.message}`);
  const path = join(out, RELEASE_MANIFEST_FILE);
  writeFileSync(path, `${JSON.stringify(manifest.data, null, 2)}\n`);
  await writeSidecar(path);
};

/** Builds the release (see the module's comment), answering nothing; any failure is a `BuildError` or the error that stopped it. */
export const buildRelease = async (options: BuildOptions, seams: BuildSeams = {}): Promise<void> => {
  const version = versionOfTag(options.tag);
  const targets = artefactTargets(options.platforms);
  const host = seams.host ?? hostPlatform();
  const hostTarget = targets.find((target) => target.platform === host);
  if (hostTarget === undefined) {
    throw new BuildError(
      `The build runs on ${host}, whose artefact it does not build (${targets.map((target) => target.platform).join(", ")}): it checks that artefact, and reads the release's identity from it, on the runner. Run it on a ${targets.map((target) => target.platform).join(" or ")} runner.`,
    );
  }
  const image = ReleaseImage.safeParse(options.image);
  if (!image.success) throw new BuildError(`The image is not one the release manifest can name: ${image.error.message}`);
  const repoRoot = seams.repoRoot ?? REPO_ROOT;
  const log = seams.log ?? ((line: string) => console.log(line));
  if (existsSync(options.out) && readdirSync(options.out).length > 0) throw new BuildError(`${options.out} is not empty: the build writes a release's assets into an empty folder.`);
  const others = options.assets ?? [];
  checkOtherAssets(others, targets.map((target) => target.name));
  mkdirSync(options.out, { recursive: true });
  await (seams.compile ?? compileWorkspace)(repoRoot, version);
  const packages = runtimePackages(repoRoot);
  const runtime = seams.nodeRuntime ?? NODE_RUNTIME;
  const work = seams.work ?? mkdtempSync(join(tmpdir(), "agent-harness-release-"));
  const assets: ReleaseAsset[] = [];
  try {
    for (const target of targets) {
      log(`${target.platform}: staging ${target.name}`);
      const archive = nodeArchive(runtime, target);
      const node = { file: await fetchNodeArchive(archive, join(work, "nodejs.org"), seams.download ?? fetchDownload), archive };
      const root = join(work, target.platform);
      await stageArtefact({ repoRoot, packages, target, version, root, onHost: target.platform === host, installDependencies: seams.installDependencies ?? pnpmInstall, node, ...(options.windowsPtyBuild !== undefined && { windowsPtyBuild: options.windowsPtyBuild }) });
      const asset = join(options.out, target.name);
      if (target.format === "zip") packZip(root, asset);
      else await packTarGz(root, asset);
      rmSync(root, { recursive: true, force: true });
      assets.push(assetOf(target, asset, await writeSidecar(asset)));
      log(`${target.platform}: wrote ${target.name}`);
    }
    for (const asset of others) {
      const written = await writeOtherAsset(asset, options.out, image.data);
      assets.push(written);
      log(`wrote ${written.name}`);
    }
    log(`${host}: unpacking and running ${hostTarget.name}`);
    const report = await (seams.verify ?? verifyArtefact)(join(options.out, hostTarget.name), hostTarget, version);
    if (report.version !== version) throw new BuildError(`The ${host} artefact's preflight reports the version ${report.version}, not ${version}.`);
    await writeManifest(options.out, report, assets, image.data);
    log(`wrote ${RELEASE_MANIFEST_FILE}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
