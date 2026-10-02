import { randomUUID } from "node:crypto";
import { removeTree } from "@agent-harness/filesystem";
import { chmod, copyFile, cp, lstat, mkdir, readdir, readlink, realpath, rename, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { GitCommit } from "@agent-harness/contracts";
import { GENERATIONS_DIRECTORY, SNAPSHOTS_DIRECTORY } from "./generations.js";
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
 *
 * The snapshot store (#499) makes them one at a time, a snapshot already
 * there for the commit reused, and sweeps them at start and hourly, after
 * the generations' sweep: it deletes each snapshot that no source holds
 * current, that no generation left on disk links into, and that was not
 * made or read since the sweep before, so one an add or a sync has made and
 * not yet recorded, or a run's resolution has read and not yet linked, is
 * kept. What a cut export or a sync cut before it recorded its snapshot
 * left is no source's current, and goes at the next sweep.
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
    await removeTree(building);
    throw error;
  }
  await walk(path, (entry, mode) => chmod(entry, mode & ~0o222));
};

/** Removes the snapshot at `path`, restoring the access needed to delete its contents first. */
export const removeSnapshot = removeTree;

/** A snapshot as the store answers it: where it lies, and whether this call made it rather than finding it there. */
export interface MadeSnapshot {
  readonly path: string;
  readonly made: boolean;
}

/** A source's current snapshot: the source's id and the commit. */
export interface CurrentSnapshot {
  readonly sourceId: string;
  readonly commit: GitCommit;
}

export interface Snapshots {
  /**
   * The snapshot of the folder `folder` of the checkout at `checkout`
   * (whose working tree is at `commit`) for the source `sourceId`: exported
   * when none is there for the commit, reused when one is. Kept by the
   * sweeps until the one after the next.
   */
  make(sourceId: string, folder: string, checkout: { readonly path: string; readonly commit: GitCommit }): Promise<MadeSnapshot>;
  /** Notes that a resolution read the snapshot at `path`: kept by the sweeps until the one after the next. */
  touch(path: string): void;
  /** Removes the snapshot at `path`, in turn with the rest of the store's work. */
  remove(path: string): Promise<void>;
  /** Deletes each snapshot nothing keeps; one that cannot be deleted is left for the next sweep. */
  sweep(): Promise<void>;
}

export interface SnapshotsOptions {
  readonly dataDir: string;
  /** The snapshots the sources hold current now. */
  readonly current: () => Iterable<CurrentSnapshot>;
}

export const createSnapshots = (options: SnapshotsOptions): Snapshots => {
  const { dataDir } = options;
  const root = join(dataDir, SNAPSHOTS_DIRECTORY);
  /** The snapshots made or read since the last sweep began. */
  let touched = new Set<string>();
  let work: Promise<unknown> = Promise.resolve();

  /** Runs `task` once the work before it has finished, whatever its outcome. */
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const next = work.then(task);
    work = next.catch(() => undefined);
    return next;
  };

  /** The snapshot a link at `target` leads into, when it leads into one. */
  const snapshotOf = (target: string): string | null => {
    const [sourceId, commit] = relative(root, target).split(sep);
    if (sourceId === undefined || commit === undefined || sourceId === ".." || isAbsolute(sourceId)) return null;
    return join(root, sourceId, commit);
  };

  /** Every snapshot a generation on disk links into: its members' links, read without following them. */
  const linked = async (): Promise<Set<string>> => {
    const found = new Set<string>();
    const generations = join(dataDir, GENERATIONS_DIRECTORY);
    for (const generation of await readdir(generations).catch(() => [])) {
      const skills = join(generations, generation, "skills");
      for (const name of await readdir(skills).catch(() => [])) {
        const target = await readlink(join(skills, name)).catch(() => null);
        const snapshot = target === null ? null : snapshotOf(resolve(skills, target));
        if (snapshot !== null) found.add(snapshot);
      }
    }
    return found;
  };

  return {
    make: (sourceId, folder, checkout) =>
      inTurn(async () => {
        const path = snapshotPath(dataDir, sourceId, checkout.commit);
        touched.add(path);
        try {
          await lstat(path);
          return { path, made: false };
        } catch {
          await exportSnapshot(checkout.path, folder, path);
          return { path, made: true };
        }
      }),

    touch(path) {
      touched.add(path);
    },

    remove: (path) => inTurn(() => removeSnapshot(path)),

    sweep: () =>
      inTurn(async () => {
        const current = [...options.current()].map(({ sourceId, commit }) => snapshotPath(dataDir, sourceId, commit));
        const links = await linked();
        // Taken and restarted in one step after the await, so a touch made while the links were read is kept.
        const kept = new Set([...touched, ...current, ...links]);
        touched = new Set();
        for (const sourceId of await readdir(root).catch(() => [])) {
          const folder = join(root, sourceId);
          const entries = await readdir(folder).catch(() => null);
          if (entries === null) continue;
          for (const entry of entries) {
            const path = join(folder, entry);
            if (kept.has(path)) continue;
            try {
              await removeSnapshot(path);
            } catch (error) {
              console.error(`Deleting the skill source snapshot ${sourceId}/${entry} failed; the next sweep will try again:`, error);
            }
          }
          // A source whose every snapshot went leaves no folder behind; one that could not be deleted keeps it.
          await rmdir(folder).catch(() => undefined);
        }
      }),
  };
};
