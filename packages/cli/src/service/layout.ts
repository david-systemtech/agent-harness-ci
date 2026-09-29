import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";
import { syncDirectory, syncTree, writeFileDurably } from "../launch/durable.js";
import { LAUNCHER_VERSION_FILE, writeLauncherVersion } from "../launch/launcher-version.js";
import { readServiceState, SERVICE_STATE_FILE, writeServiceState, type ServiceState } from "../launch/state.js";
import { isComplete, VERSION_CLI_ENTRY, VERSION_SENTINEL, versionDirectory, versionNode, VERSIONS_DIRECTORY } from "../launch/versions.js";
import { missingDirectories, removeEmptyDirectories } from "./definition.js";
import { ServiceError } from "./errors.js";

/**
 * The launcher's files as `service install` lays them out in the data
 * directory when no launcher runs (launcher-update spec, "Versions and the
 * launcher"): the version the running CLI belongs to, complete in the
 * versions directory, named active and the launcher's in the service state
 * and in the launcher version file. While a launcher runs it is their only
 * writer, and install leaves them alone.
 */

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A release's server artefact, unpacked: a folder holding its own Node and its CLI. */
export interface UnpackedVersion {
  readonly root: string;
  /** Its version: its CLI package's. */
  readonly version: string;
}

/**
 * The unpacked version whose CLI entry is `entry` (the real path of the
 * running CLI's entry script): the folder `VERSION_CLI_ENTRY` is in, when it
 * holds the version's own Node for `platform` (`versionNode`) and a release
 * version in its CLI package. Anything else, a checkout run with the
 * machine's Node included, is a `ServiceError`: the service runs a version's
 * own Node, and a checkout has none.
 */
export const unpackedVersionOf = (entry: string | undefined, platform: NodeJS.Platform): UnpackedVersion => {
  const notOne = (why: string) =>
    new ServiceError(
      `\`${PRODUCT_NAME} service install\` runs from a release's unpacked artefact, which carries its own Node, and makes it the service's version; ${why}.`,
    );
  if (entry === undefined) throw notOne("this CLI was started without an entry script");
  const root = resolve(entry, ...VERSION_CLI_ENTRY.map(() => ".."));
  if (join(root, ...VERSION_CLI_ENTRY) !== entry) throw notOne(`${entry} is not a version's ${VERSION_CLI_ENTRY.join("/")}`);
  const node = join(root, ...versionNode(platform));
  if (!existsSync(node)) throw notOne(`${root} has no ${node}`);
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")) as { version?: unknown }).version;
  } catch {
    version = undefined;
  }
  if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) throw notOne(`${root} names no release version in its CLI's package.json`);
  return { root, version };
};

/** Whether `a` and `b` are the same folder, links resolved; a folder that is not there is no folder. */
const sameFolder = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** The version install names, and how to take back what it did to put it there. */
export interface PlacedVersion {
  readonly version: string;
  /** The folder it was copied from, when install copied it into the versions directory. */
  readonly copiedFrom?: string;
  /** Removes the copy, and the folders made for it, when there was one. */
  readonly undo: () => void;
}

const nothingToUndo = () => undefined;

/** A staging folder `placeVersion` copies a version into: dot-led, so no version is ever named by it. */
const partialFolder = (version: string): string => `.${version}.${randomUUID()}.partial`;
const PARTIAL = /^\..+\.partial$/;

/** Removes the staging folders a copy cut short by a crash or a kill left in `versions`, which install alone writes while no launcher runs. */
const clearPartials = (versions: string): void => {
  let entries;
  try {
    entries = readdirSync(versions, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory() && PARTIAL.test(entry.name)) rmSync(join(versions, entry.name), { recursive: true, force: true });
};

/**
 * Makes `unpacked` a version in `dataDir`'s versions directory and names it.
 * One already in the versions directory (the install script unpacks there)
 * is named by its folder, and must be complete. One outside it (a desktop's
 * bundled artefact) is copied in beside the others, put on disk, renamed into
 * place and completed with its sentinel, written last, unless a complete copy
 * is already there; a folder of it without the sentinel, or a staging
 * folder, is what a copy cut short left, and is replaced or removed.
 */
export const placeVersion = (dataDir: string, unpacked: UnpackedVersion): PlacedVersion => {
  const versions = join(dataDir, VERSIONS_DIRECTORY);
  if (sameFolder(dirname(unpacked.root), versions)) {
    const version = basename(unpacked.root);
    if (!isComplete(dataDir, version)) {
      throw new ServiceError(
        `${version} in ${versions} has no sentinel (${VERSION_SENTINEL}), so it is not a version: whatever put it there did not finish. Unpack it again.`,
      );
    }
    return { version, undo: nothingToUndo };
  }
  const { version, root } = unpacked;
  if (isComplete(dataDir, version)) return { version, undo: nothingToUndo };
  const created = missingDirectories(versions);
  const target = versionDirectory(dataDir, version);
  const partial = join(versions, partialFolder(version));
  const undo = () => {
    rmSync(partial, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    removeEmptyDirectories(created);
  };
  try {
    mkdirSync(versions, { recursive: true });
    clearPartials(versions);
    cpSync(root, partial, { recursive: true, verbatimSymlinks: true, filter: (source) => source !== join(root, VERSION_SENTINEL) });
    syncTree(partial);
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
    syncDirectory(versions);
    writeFileDurably(join(target, VERSION_SENTINEL), "");
  } catch (error) {
    undo();
    throw new ServiceError(`Could not copy ${version} from ${root} into ${versions}: ${reasonOf(error)}`, { cause: error });
  }
  return { version, copiedFrom: root, undo };
};

/** Reads the file at `path` so it can be put back: answers the put-back, which removes it when there was none. */
const keep = (path: string): (() => void) => {
  let previous: string | undefined;
  try {
    previous = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ServiceError(`Could not read ${path}, so nothing was changed: ${reasonOf(error)}`, { cause: error });
  }
  return () => (previous === undefined ? rmSync(path, { force: true }) : writeFileDurably(path, previous));
};

/**
 * Names `version` active and the launcher's: in the service state and in the
 * launcher version file, durably. A state already there keeps the update it
 * records as pending, which the launcher rolls back at its next start, and
 * its active version becomes the previous one; its watch ends, since the
 * version it watched no longer runs. A state that cannot be used is
 * replaced. Answers how to put both files back as they were.
 */
export const nameVersion = (dataDir: string, version: string): (() => void) => {
  const putBack = [keep(join(dataDir, SERVICE_STATE_FILE)), keep(join(dataDir, LAUNCHER_VERSION_FILE))];
  const undo = () => {
    for (const step of putBack) step();
  };
  const read = readServiceState(dataDir);
  const next: ServiceState =
    "state" in read
      ? {
          ...read.state,
          activeVersion: version,
          launcherVersion: version,
          previousVersion: read.state.activeVersion === version ? read.state.previousVersion : read.state.activeVersion,
          watchDeadline: null,
        }
      : { activeVersion: version, previousVersion: null, launcherVersion: version, pendingUpdate: null, watchDeadline: null };
  try {
    writeServiceState(dataDir, next);
    writeLauncherVersion(dataDir, version);
  } catch (error) {
    undo();
    throw new ServiceError(`Could not name ${version} in the service state and the launcher version file: ${reasonOf(error)}`, { cause: error });
  }
  return undo;
};
