import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { SNAPSHOTS_DIRECTORY } from "./generations.js";
import { PROVENANCE_MANIFEST } from "./provenance.js";

/**
 * A skill source's snapshots (skills spec, "Skill sources"; ADR 0029): the
 * source's folder exported at a commit into an immutable, read-only copy
 * under the data directory, `skills/snapshots/<source id>/<commit>`, holding
 * the folder at its path in the repository and any provenance manifest one
 * level up from it. A source's members are read, and linked into a run's
 * generation, from its current snapshot, so a later sync, which makes a new
 * snapshot, never changes a running process's files. Nothing in a snapshot
 * is written after it is made: its files and folders lose their write
 * permission, their execute bits kept for a skill's scripts.
 */

/** The prefix of a snapshot being made, renamed to its commit once whole. */
const BUILDING = ".building-";

/** Where `sourceId`'s snapshot at `commit` lies. */
export const snapshotPath = (dataDir: string, sourceId: string, commit: string): string => join(dataDir, SNAPSHOTS_DIRECTORY, sourceId, commit);

/** `folder`'s segments, from a repository's root; none for the root. */
const segmentsOf = (folder: string): string[] => (folder === "." ? [] : folder.split("/"));

/** Whether `path` (under a tree whose links are resolved) is there with no link on the way: what a folder or manifest must be to be exported. */
const isPlain = async (path: string): Promise<boolean> => {
  try {
    return (await realpath(path)) === path;
  } catch {
    return false;
  }
};

/** Applies `change` to every entry under `path` and then `path` itself, links left alone. */
const walk = async (path: string, change: (path: string, mode: number) => Promise<void>): Promise<void> => {
  const found = await lstat(path);
  if (found.isSymbolicLink()) return;
  if (found.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry), change);
  await change(path, found.mode);
};

/**
 * Exports `folder` of the checkout at `checkout`, whose working tree is at
 * the commit, into a new snapshot at `path`: the folder's files (links kept
 * as links, `.git` left out) and the provenance manifest one level up when
 * the repository has one there, each at its path in the repository. A
 * folder that is not a directory there, or that a link leads to, exports
 * nothing of itself, so it yields no member. Made whole under a building
 * name and renamed into place, then made read-only.
 */
export const exportSnapshot = async (checkout: string, folder: string, path: string): Promise<void> => {
  const building = join(dirname(path), `${BUILDING}${randomUUID()}`);
  await mkdir(building, { recursive: true });
  try {
    const tree = await realpath(checkout);
    const segments = segmentsOf(folder);
    const source = join(tree, ...segments);
    const target = join(building, ...segments);
    if ((await isPlain(source)) && (await lstat(source)).isDirectory()) {
      await cp(source, target, { recursive: true, verbatimSymlinks: true, filter: (entry) => basename(entry) !== ".git" });
    }
    if (segments.length > 0) {
      const up = segmentsOf(posix.dirname(folder));
      const manifest = join(tree, ...up, PROVENANCE_MANIFEST);
      if ((await isPlain(manifest)) && (await lstat(manifest)).isFile()) {
        await mkdir(join(building, ...up), { recursive: true });
        await copyFile(manifest, join(building, ...up, PROVENANCE_MANIFEST));
      }
    }
    await rename(building, path);
  } catch (error) {
    await rm(building, { recursive: true, force: true });
    throw error;
  }
  await walk(path, (entry, mode) => chmod(entry, mode & ~0o222));
};

/** Removes the snapshot at `path`, giving its files and folders their write permission back first. */
export const removeSnapshot = async (path: string): Promise<void> => {
  try {
    await walk(path, (entry, mode) => chmod(entry, mode | 0o200));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(path, { recursive: true, force: true });
};
