import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { PRODUCT_NAME, RELEASE_MANIFEST_FILE, ReleaseAssetKind, type ReleaseAsset, type ReleaseImage } from "@agent-harness/contracts";
import { writeSidecar } from "./archive.js";
import { BuildError } from "./targets.js";

/**
 * The release's assets beside the server artefacts (launcher-update spec,
 * "The release"; #358): the install scripts, the compose file, the host-side
 * updater and the contracts' JSON Schema export, each named by the workflow's
 * asset list as its kind and the file or folder it is made from. The build
 * writes each into its output folder with a sidecar, as it does an artefact,
 * and lists it in `release.json`.
 */

/** One of the release's other assets: its kind, and the file or folder it is made from. */
export interface OtherAsset {
  readonly kind: string;
  /** A file, published under its own name; or a folder, published as the gzipped tar `agent-harness-<kind>.tar.gz` holding it under its own name. */
  readonly path: string;
}

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
 * Checks the other `assets` before anything is built: each exists, is of a
 * kind the manifest can list that is not the artefacts' own, and has a name
 * no other asset has, the artefacts' (`artefactNames`) and `release.json`
 * among them; a compose file names the unreleased image exactly once. Any
 * other is a `BuildError`.
 */
export const checkOtherAssets = (assets: readonly OtherAsset[], artefactNames: readonly string[]): void => {
  const names = new Set([...artefactNames, RELEASE_MANIFEST_FILE]);
  for (const asset of assets) {
    if (!existsSync(asset.path)) throw new BuildError(`The ${asset.kind} asset ${asset.path} does not exist.`);
    if (!ReleaseAssetKind.safeParse(asset.kind).success) throw new BuildError(`${JSON.stringify(asset.kind)} is not an asset kind: lowercase letters, digits and hyphens, such as install-script.`);
    if (asset.kind === "environment") throw new BuildError(`${asset.path} cannot be an environment asset: those are the build's own artefacts.`);
    const name = nameOf(asset);
    if (names.has(name)) throw new BuildError(`The release would publish two assets named ${name}.`);
    names.add(name);
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
  return { name, kind: asset.kind, platform: null, format: formatOf(name), size: statSync(path).size, sha256 };
};
