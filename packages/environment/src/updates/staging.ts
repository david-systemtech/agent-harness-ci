import { removeTreeSync, requireCopyRoom } from "@agent-harness/filesystem";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { cp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ARTEFACT_CLI_ENTRY, ARTEFACT_CLI_PACKAGE, artefactNode, DATABASE_FILE, INSTALL_RESERVE_BYTES } from "@agent-harness/contracts";
import { stagingArea } from "../serve/launcher-files.js";

/**
 * Staging an artefact (launcher-update spec, "Staging"; #343, #347, #789):
 * the server artefact a path names (`update apply`'s, or the desktop's
 * bundled one), or one downloaded from its release into the staging area,
 * is put in the staging area, the one place in the data directory the
 * environment writes of the launcher's, as the folder `install?` names: an
 * archive unpacked, a folder an artefact is unpacked in (as the desktop
 * carries it) copied. The launcher moves an installed version out of it; a
 * version it refused is removed from it.
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

/**
 * An artefact could not be staged: the path names neither a file nor a
 * folder (`missing`); or the file did not unpack, or the folder holds no
 * artefact of the version or did not copy (`unusable`).
 */
export class StagingError extends Error {
  readonly kind: "missing" | "unusable";

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

/** What a path names: an archive (a file), the folder an artefact is unpacked in, or neither. */
const shapeAt = (path: string): "archive" | "folder" | undefined => {
  try {
    const stats = statSync(path);
    return stats.isFile() ? "archive" : stats.isDirectory() ? "folder" : undefined;
  } catch {
    return undefined;
  }
};

/** Whether `path` is a file that is there now. */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The version the CLI package of the artefact unpacked in `folder` declares, or undefined when it names none: missing, not JSON, or no string there. */
const declaredVersion = (folder: string): string | undefined => {
  try {
    const { version } = JSON.parse(readFileSync(join(folder, ...ARTEFACT_CLI_PACKAGE), "utf8")) as { readonly version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Why `folder` holds no server artefact of `version` unpacked, or undefined
 * when it holds one: this platform's Node, the CLI's entry, and the CLI
 * package declaring that version, as a release lays them out. Read before
 * anything is copied, so a folder of anything else is never copied into the
 * staging area; the launcher's `install?` checks the copy again, whole.
 */
const notArtefactOf = (folder: string, version: string): string | undefined => {
  const node = join(folder, ...artefactNode(process.platform));
  if (!isFile(node)) return `it has no Node at ${node}`;
  const entry = join(folder, ...ARTEFACT_CLI_ENTRY);
  if (!isFile(entry)) return `it has no CLI entry at ${entry}`;
  const declared = declaredVersion(folder);
  if (declared !== version) return `its CLI package ${join(folder, ...ARTEFACT_CLI_PACKAGE)} ${declared === undefined ? "declares no release version" : `declares ${declared}`}`;
  return undefined;
};

/** The folder in the staging area of `dataDir` that `version` is staged in. */
export const stagedVersion = (dataDir: string, version: string): string => join(stagingArea(dataDir), version);

/**
 * Puts the artefact at `artefact`, of `version`, in the staging area of
 * `dataDir`, and answers the folder it is in, `staging/<version>`. An
 * archive is unpacked, and a folder an artefact is unpacked in copied (its
 * links kept as the links they are, as `tar` keeps them), into a fresh
 * folder beside it, which is moved into place whole, replacing whatever an
 * earlier attempt left there, so the folder `install?` names is never half
 * a version; the folder copied from is left as it was. Throws a
 * `StagingError` when the path names nothing to stage, or what it names
 * does not unpack, holds no artefact of `version` or does not copy, leaving
 * nothing.
 */
export const stageArtefact = async (options: {
  readonly dataDir: string;
  readonly version: string;
  readonly artefact: string;
  readonly unpack: Unpack;
}): Promise<string> => {
  const { dataDir, version, artefact } = options;
  const shape = shapeAt(artefact);
  if (shape === undefined) throw new StagingError("missing", `No artefact is at ${artefact} on this machine.`);
  const unusable = shape === "folder" ? notArtefactOf(artefact, version) : undefined;
  if (unusable !== undefined) throw new StagingError("unusable", `${artefact} is not a server artefact of ${version}: ${unusable}.`);
  const area = stagingArea(dataDir);
  mkdirSync(area, { recursive: true, mode: 0o700 });
  if (shape === "folder") {
    try {
      requireCopyRoom(artefact, dataDir, DATABASE_FILE, INSTALL_RESERVE_BYTES);
    } catch (cause) {
      throw new StagingError("unusable", cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }
  const partial = join(area, `.${version}-${randomUUID()}`);
  mkdirSync(partial, { mode: 0o700 });
  try {
    if (shape === "archive") await options.unpack(artefact, partial);
    else await cp(await realpath(artefact), partial, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    removeTreeSync(partial);
    const failed = shape === "archive" ? "did not unpack" : "did not copy";
    throw new StagingError("unusable", `The artefact at ${artefact} ${failed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const staged = stagedVersion(dataDir, version);
  try {
    removeTreeSync(staged);
    renameSync(partial, staged);
  } catch (error) {
    removeTreeSync(partial);
    throw error;
  }
  return staged;
};

/** Removes `version` from the staging area of `dataDir`: the launcher refused it. */
export const unstage = (dataDir: string, version: string): void => removeTreeSync(stagedVersion(dataDir, version));
