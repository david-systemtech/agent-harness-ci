import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { artefactNode } from "@agent-harness/contracts/launcher";
import { extractMember, sha256OfFile } from "./archive.js";
import { BuildError, type ArtefactTarget } from "./targets.js";

/**
 * The Node runtime each server artefact carries (launcher-update spec, "The
 * release"; #356), so no machine needs Node installed: the pinned version's
 * binary and licence, taken from nodejs.org's archive for the platform and
 * checked against the pinned SHA-256 before anything is read from it.
 */

/** A pinned Node release: its version, and the SHA-256 of its archive for each platform, as nodejs.org's `SHASUMS256.txt` lists it. */
export interface NodeRuntime {
  readonly version: string;
  readonly sha256: Readonly<Record<string, string>>;
}

/**
 * The Node the artefacts carry: the newest 24 (the LTS line AGENTS.md
 * requires) when #356 was built. The digests are nodejs.org's
 * https://nodejs.org/dist/v24.21.0/SHASUMS256.txt entries for the three
 * archives; a new pin takes the new version's.
 */
export const NODE_RUNTIME: NodeRuntime = {
  version: "24.21.0",
  sha256: {
    "linux-x64": "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    "darwin-arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    "win32-x64": "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  },
};

/** Node's archive for one platform: where nodejs.org publishes it, its folder at the archive's top, its pinned digest and how it is packed. */
export interface NodeArchive {
  readonly url: string;
  /** Its file name, and the folder its files are in inside it: `node-v24.21.0-linux-x64`, with `.tar.gz` or `.zip`. */
  readonly top: string;
  readonly file: string;
  readonly sha256: string;
  readonly format: "tar.gz" | "zip";
}

/** The archive of `runtime` for `target`, as nodejs.org names it (`win` for Windows); a platform with no pin is a `BuildError`. */
export const nodeArchive = (runtime: NodeRuntime, target: ArtefactTarget): NodeArchive => {
  const sha256 = runtime.sha256[target.platform];
  if (sha256 === undefined) throw new BuildError(`No Node archive is pinned for ${target.platform}.`);
  const top = `node-v${runtime.version}-${target.os === "win32" ? "win" : target.os}-${target.cpu}`;
  const format = target.os === "win32" ? "zip" : "tar.gz";
  return { url: `https://nodejs.org/dist/v${runtime.version}/${top}.${format}`, top, file: `${top}.${format}`, sha256, format };
};

/** Downloads `url` to `file`. */
export type Download = (url: string, file: string) => Promise<void>;

/** The preset download: `fetch`, streamed to the file; an answer other than 200 is a `BuildError`. */
export const fetchDownload: Download = async (url, file) => {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new BuildError(`${url} answered ${response.status} ${response.statusText}.`);
  await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(file));
};

/**
 * The archive `archive` in the folder `cache`, downloaded there the first
 * time it is asked for, and checked against its pinned digest every time: one
 * that does not match is removed and is a `BuildError`.
 */
export const fetchNodeArchive = async (archive: NodeArchive, cache: string, download: Download): Promise<string> => {
  const file = join(cache, archive.file);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    await download(archive.url, `${file}.partial`);
    renameSync(`${file}.partial`, file);
  }
  const digest = await sha256OfFile(file);
  if (digest !== archive.sha256) {
    rmSync(file, { force: true });
    throw new BuildError(`${archive.url} has the SHA-256 ${digest}, not the pinned ${archive.sha256}.`);
  }
  return file;
};

/**
 * Puts Node's binary and its licence from the archive at `file` into the
 * artefact folder `root`: the binary where `artefactNode` names it (the
 * archive's own layout below its top folder, `node/bin/node` or
 * `node\node.exe`), the licence as `node/LICENSE`. Nothing else of the
 * archive is carried: npm, corepack and the headers are not needed to run.
 */
export const placeNodeRuntime = async (file: string, archive: NodeArchive, target: ArtefactTarget, root: string): Promise<void> => {
  const binary = artefactNode(target.os);
  const [folder = "node", ...inArchive] = binary;
  await extractMember(file, archive.format, [archive.top, ...inArchive].join("/"), join(root, ...binary));
  chmodSync(join(root, ...binary), 0o755);
  await extractMember(file, archive.format, `${archive.top}/LICENSE`, join(root, folder, "LICENSE"));
};
