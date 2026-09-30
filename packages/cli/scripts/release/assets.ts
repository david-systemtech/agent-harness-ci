import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { AssetFormat, PRODUCT_NAME, RELEASE_MANIFEST_FILE, ReleaseAssetKind, ReleasePlatform, type ReleaseAsset, type ReleaseImage } from "@agent-harness/contracts";
import { writeSidecar } from "./archive.js";
import { BuildError } from "./targets.js";

/**
 * The release's assets beside the server artefacts (launcher-update spec,
 * "The release"; #358): the install scripts, the compose file, the host-side
 * updater, the contracts' JSON Schema export and the desktop builds (#359),
 * each named by the workflow's asset list as its kind and the file or folder
 * it is made from, a desktop build with its platform and format too. The
 * build writes each into its output folder with a sidecar, as it does an
 * artefact, and lists it in `release.json`.
 */

/** The platform an asset is built for and how it is packed, as the manifest lists them. */
export interface AssetTarget {
  readonly platform: string;
  readonly format: string;
}

/** One of the release's other assets: its kind, and the file or folder it is made from. */
export interface OtherAsset {
  readonly kind: string;
  /** A file, published under its own name; or a folder, published as the gzipped tar `agent-harness-<kind>.tar.gz` holding it under its own name. */
  readonly path: string;
  /**
   * Its platform and format, which a desktop build needs: the environment
   * stages the desktop's build by the platform and format its shell reports
   * (#354). Without, the asset takes any platform and the format its name says.
   */
  readonly target?: AssetTarget;
}

/** The kind of the desktop's builds, which the environment stages by platform and format. */
export const DESKTOP_KIND = "desktop";

/**
 * The compose file's image before a release names its own
 * (`scripts/compose.yaml`, #349): the build writes the release's image
 * reference in its place, so the published file runs that release's image
 * when no `AGENT_HARNESS_IMAGE` is set.
 */
export const UNRELEASED_IMAGE = "git.systemtech.dev:5526/david/agent-harness:unreleased";

const run = promisify(execFile);

const isFolder = (asset: OtherAsset): boolean => statSync(asset.path).isDirectory();

/** The name `asset` is published under. */
const nameOf = (asset: OtherAsset): string => (isFolder(asset) ? `${PRODUCT_NAME}-${asset.kind}.tar.gz` : basename(asset.path));

/** How an asset is packed, as its name says: a gzipped tar, a zip, or null for a plain file. */
const formatOf = (name: string): string | null => (name.endsWith(".tar.gz") ? "tar.gz" : name.endsWith(".zip") ? "zip" : null);

/** How many times the compose file at `path` names the unreleased image. */
const placeholdersIn = (path: string): number => readFileSync(path, "utf8").split(UNRELEASED_IMAGE).length - 1;

/**
 * Checks the platform and format of `asset`: a desktop build has both, each
 * one the manifest can list, and no other desktop build (`desktops`, the
 * builds checked before it) has the same two, since the environment would
 * stage only the first. Any other is a `BuildError`.
 */
const checkTarget = (asset: OtherAsset, desktops: Set<string>): void => {
  const { target } = asset;
  if (target === undefined) {
    if (asset.kind === DESKTOP_KIND) throw new BuildError(`${basename(asset.path)} is a desktop build without its platform and format: --asset desktop:<platform>:<format>=<path>.`);
    return;
  }
  if (!ReleasePlatform.safeParse(target.platform).success) throw new BuildError(`${JSON.stringify(target.platform)} is not a platform: <os>-<arch> as Node names them, such as darwin-arm64.`);
  if (!AssetFormat.safeParse(target.format).success) throw new BuildError(`${JSON.stringify(target.format)} is not a format: lowercase letters and digits, in parts joined by dots, such as nsis or tar.gz.`);
  if (asset.kind !== DESKTOP_KIND) return;
  const key = `${target.platform} as ${target.format}`;
  if (desktops.has(key)) throw new BuildError(`The release would publish two desktop builds for ${key}.`);
  desktops.add(key);
};

/**
 * Checks the other `assets` before anything is built: each exists, is of a
 * kind the manifest can list that is not the artefacts' own, with a platform
 * and format as `checkTarget` asks, and neither its name nor its sidecar's is
 * one another asset or its sidecar has, the artefacts' (`artefactNames`) and
 * `release.json` among them; a compose file names the unreleased image
 * exactly once. Any other is a `BuildError`.
 */
export const checkOtherAssets = (assets: readonly OtherAsset[], artefactNames: readonly string[]): void => {
  const filesOf = (name: string): string[] => [name, `${name}.sha256`];
  const names = new Set([...artefactNames, RELEASE_MANIFEST_FILE].flatMap(filesOf));
  const desktops = new Set<string>();
  for (const asset of assets) {
    if (!existsSync(asset.path)) throw new BuildError(`The ${asset.kind} asset ${asset.path} does not exist.`);
    if (!ReleaseAssetKind.safeParse(asset.kind).success) throw new BuildError(`${JSON.stringify(asset.kind)} is not an asset kind: lowercase letters, digits and hyphens, such as install-script.`);
    if (asset.kind === "environment") throw new BuildError(`${asset.path} cannot be an environment asset: those are the build's own artefacts.`);
    checkTarget(asset, desktops);
    const name = nameOf(asset);
    const taken = filesOf(name).find((file) => names.has(file));
    if (taken !== undefined) throw new BuildError(`The release would publish two assets named ${taken}.`);
    for (const file of filesOf(name)) names.add(file);
    if (asset.kind === "compose") {
      const found = placeholdersIn(asset.path);
      if (found !== 1) throw new BuildError(`${name} names the image ${UNRELEASED_IMAGE} ${found} times, not once: the release writes its own image there.`);
    }
  }
};

/**
 * Writes `asset` into `out` with its sidecar, as the release publishes it
 * (a compose file naming `image`'s reference), and answers its manifest
 * entry.
 */
export const writeOtherAsset = async (asset: OtherAsset, out: string, image: ReleaseImage): Promise<ReleaseAsset> => {
  const name = nameOf(asset);
  const path = join(out, name);
  if (isFolder(asset)) await run("tar", ["-czf", path, "-C", dirname(asset.path), basename(asset.path)]);
  else if (asset.kind === "compose") writeFileSync(path, readFileSync(asset.path, "utf8").replace(UNRELEASED_IMAGE, () => image.reference));
  else copyFileSync(asset.path, path);
  const sha256 = await writeSidecar(path);
  return { name, kind: asset.kind, platform: asset.target?.platform ?? null, format: asset.target?.format ?? formatOf(name), size: statSync(path).size, sha256 };
};
