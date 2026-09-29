import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stagingArea } from "../serve/launcher-files.js";

/**
 * Staging an artefact (launcher-update spec, "Staging"; #343, #347): the
 * server artefact a path names (the desktop's bundled one, or `update
 * apply`'s), or one downloaded from its release into the staging area, is
 * unpacked into the staging area, the one place in the data directory the
 * environment writes of the launcher's, as the folder `install?` names. The
 * launcher moves an installed version out of it; a version it refused is
 * removed from it.
 */

/** Unpacks the archive `archive` into the empty folder `into`, the archive's top at the folder's. Rejects saying why when it cannot. */
export type Unpack = (archive: string, into: string) => Promise<void>;

/** How long an unpack may take before it is given up: a server artefact is a few hundred megabytes at most. */
const UNPACK_TIMEOUT_MS = 5 * 60_000;

/**
 * The preset unpack: the platform's `tar`, which reads a gzipped tar on
 * Linux and macOS and, as the `tar` Windows ships, a zip on Windows, telling
 * the compression from the archive itself.
 */
export const tarUnpack: Unpack = (archive, into) =>
  new Promise((resolve, reject) => {
    execFile("tar", ["-xf", archive, "-C", into], { timeout: UNPACK_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message, { cause: error }));
      else resolve();
    });
  });

/** An artefact could not be staged: the path names no file (`missing`), or the file did not unpack (`unpack`). */
export class StagingError extends Error {
  readonly kind: "missing" | "unpack";

  constructor(kind: StagingError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StagingError";
    this.kind = kind;
  }
}

/** A fresh file in the staging area of `dataDir` that `version`'s artefact is downloaded into before it is unpacked; the area is made when missing. */
export const downloadDestination = (dataDir: string, version: string): string => {
  const area = stagingArea(dataDir);
  mkdirSync(area, { recursive: true, mode: 0o700 });
  return join(area, `.${version}-${randomUUID()}.download`);
};

/** The folder in the staging area of `dataDir` that `version` is staged in. */
export const stagedVersion = (dataDir: string, version: string): string => join(stagingArea(dataDir), version);

/**
 * Unpacks the artefact at `artefact`, of `version`, into the staging area
 * of `dataDir`, and answers the folder it is in, `staging/<version>`. The
 * artefact is unpacked into a fresh folder beside it and moved into place
 * whole, replacing whatever an earlier attempt left there, so the folder
 * `install?` names is never half a version. Throws a `StagingError` when
 * the path names no file or the file does not unpack, leaving nothing.
 */
export const stageArtefact = async (options: {
  readonly dataDir: string;
  readonly version: string;
  readonly artefact: string;
  readonly unpack: Unpack;
}): Promise<string> => {
  const { dataDir, version, artefact } = options;
  let isFile: boolean;
  try {
    isFile = statSync(artefact).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new StagingError("missing", `No artefact is at ${artefact} on this machine.`);
  const area = stagingArea(dataDir);
  mkdirSync(area, { recursive: true, mode: 0o700 });
  const partial = join(area, `.${version}-${randomUUID()}`);
  mkdirSync(partial, { mode: 0o700 });
  try {
    await options.unpack(artefact, partial);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw new StagingError("unpack", `The artefact at ${artefact} did not unpack: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const staged = stagedVersion(dataDir, version);
  try {
    rmSync(staged, { recursive: true, force: true });
    renameSync(partial, staged);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  return staged;
};

/** Removes `version` from the staging area of `dataDir`: the launcher refused it. */
export const unstage = (dataDir: string, version: string): void => rmSync(stagedVersion(dataDir, version), { recursive: true, force: true });
