import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Clock } from "./clock.js";

/**
 * The data directory's trash (skills spec, "The own directory and Carry
 * over", a chosen default): what the environment removes of what a person
 * wrote by hand is moved here, not deleted, and deleted once thirty days
 * old. Each thing trashed lies in an entry of its own, named for when it
 * was trashed, so its age never depends on a file's times.
 */

/** The trash's folder in the data directory. */
export const TRASH_DIRECTORY = "trash";

/** How long the trash keeps what it holds. */
export const TRASH_KEPT_MS = 30 * 24 * 60 * 60_000;

/** How often the trash is swept, after the sweep at start. */
export const TRASH_SWEEP_INTERVAL_MS = 60 * 60_000;

/** An entry's name: when it was trashed, in milliseconds since the epoch, then an id of its own. */
const ENTRY = /^(\d+)-[0-9a-f-]+$/;

export interface Trash {
  /** The trash's folder. */
  readonly root: string;
  /** Moves `path` into a new entry of the trash, keeping its name; answers where it now lies. */
  put(path: string): Promise<string>;
  /** Moves what `put` trashed back to where it was: the command that trashed it was not accepted. */
  restore(trashed: string, to: string): Promise<void>;
  /** Deletes every entry trashed thirty days ago or more; one that cannot be deleted is left for the next sweep. */
  sweep(): Promise<void>;
  /** Sweeps now, then hourly; answers the stop. */
  start(): () => void;
}

/** Moves `from` to `to`; across file systems, by a copy that keeps links as they are, then a removal. */
const move = async (from: string, to: string): Promise<void> => {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
};

export const createTrash = (options: { readonly dataDir: string; readonly clock: Clock }): Trash => {
  const { clock } = options;
  const root = join(options.dataDir, TRASH_DIRECTORY);

  const sweep = async (): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    const cutoff = clock.now().getTime() - TRASH_KEPT_MS;
    for (const entry of entries) {
      const trashedAt = ENTRY.exec(entry)?.[1];
      if (trashedAt === undefined || Number(trashedAt) > cutoff) continue;
      try {
        await rm(join(root, entry), { recursive: true, force: true });
      } catch (error) {
        console.error(`Deleting ${entry} from the trash failed; the next sweep will try again:`, error);
      }
    }
  };

  return {
    root,
    async put(path) {
      const entry = join(root, `${clock.now().getTime()}-${randomUUID()}`);
      await mkdir(entry, { recursive: true });
      const trashed = join(entry, basename(path));
      try {
        await move(path, trashed);
      } catch (error) {
        await rm(entry, { recursive: true, force: true });
        throw error;
      }
      return trashed;
    },
    async restore(trashed, to) {
      await move(trashed, to);
      await rm(dirname(trashed), { recursive: true, force: true });
    },
    sweep,
    start() {
      const run = () => void sweep().catch((error: unknown) => console.error("The trash's sweep failed:", error));
      run();
      const timer = clock.setInterval(run, TRASH_SWEEP_INTERVAL_MS);
      return () => timer.cancel();
    },
  };
};
