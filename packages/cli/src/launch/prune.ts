import { removeTreeSync } from "@agent-harness/filesystem";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compareReleaseVersions, RELEASE_VERSION_PATTERN, UPDATE_ID_PATTERN } from "@agent-harness/contracts/launcher";
import { SNAPSHOTS_DIRECTORY } from "./snapshot.js";
import { completeVersions, VERSION_SENTINEL, versionDirectory, VERSIONS_DIRECTORY } from "./versions.js";

/**
 * What the end of a watch clears away (launcher-update spec, "Trial, commit,
 * rollback and the watch" and "Kept"): the database snapshots, which only a
 * rollback reads, and the versions no one will run. The launcher calls them
 * as a watch ends with no update pending, so no rollback can need a snapshot
 * and no version is being switched to. A version an install is moving in
 * has no sentinel until the move's last step: the install waits on its
 * preflight, which runs in the staging area, and moves the version in, sentinel
 * and all, in one step, and the launcher records it staged before any timer
 * can run again. On Windows a move that meets a file still held waits on the
 * timer between tries (`install.ts`, up to `MOVE_RETRY_MS`): between them the
 * version's folder is absent, or, while its rename back to the staging area
 * waits, there without its sentinel, so a watch ending then may remove it and
 * the install is refused `io`, to be asked for again.
 */

/** How many versions before the active one a watch's end keeps, by precedence. */
export const KEPT_BEFORE_ACTIVE = 2;

/** The names in `dir`, none when it is not there. */
const namesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

/** The update ids the snapshots folder of `dataDir` holds a snapshot of, whole or cut short, in order. */
export const snapshotsIn = (dataDir: string): string[] =>
  [...new Set(namesIn(join(dataDir, SNAPSHOTS_DIRECTORY)).map((name) => name.replace(/\.staging$/, "")))].filter((name) => UPDATE_ID_PATTERN.test(name)).sort();

/** What a watch's end keeps besides the active version and the two before it. */
export interface KeptBeside {
  readonly activeVersion: string;
  /** The running launcher's own version, whose files it runs from. */
  readonly launcherVersion: string;
  /** The version staged for the environment's next update, if one is. */
  readonly stagedVersion: string | null;
}

/** The version folders in `dataDir`, complete or not, by precedence. */
const versionFolders = (dataDir: string): string[] =>
  namesIn(join(dataDir, VERSIONS_DIRECTORY))
    .filter((name) => RELEASE_VERSION_PATTERN.test(name))
    .sort(compareReleaseVersions);

/**
 * Which version folders in `dataDir` a watch's end keeps and which it
 * prunes, each by precedence. Kept: the active version, the two complete
 * versions before it, the launcher's own and the staged one. Pruned: every
 * other folder named by a version, complete or not, since one without its
 * sentinel is what an install or a removal cut short left.
 */
export const pruning = (dataDir: string, { activeVersion, launcherVersion, stagedVersion }: KeptBeside): { readonly kept: string[]; readonly pruned: string[] } => {
  const before = completeVersions(dataDir)
    .filter((version) => compareReleaseVersions(version, activeVersion) < 0)
    .sort(compareReleaseVersions)
    .slice(-KEPT_BEFORE_ACTIVE);
  const keep = new Set([activeVersion, ...before, launcherVersion, ...(stagedVersion === null ? [] : [stagedVersion])]);
  const folders = versionFolders(dataDir);
  return { kept: folders.filter((version) => keep.has(version)), pruned: folders.filter((version) => !keep.has(version)) };
};

/** Removes `version` from the versions directory of `dataDir`: its sentinel first, so a removal cut short leaves no version behind to run. */
export const removeVersion = (dataDir: string, version: string): void => {
  const folder = versionDirectory(dataDir, version);
  removeTreeSync(folder, (path, options) => {
    rmSync(join(path, VERSION_SENTINEL), { force: true });
    rmSync(path, options);
  });
};
