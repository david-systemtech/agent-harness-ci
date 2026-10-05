import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Restores owner access before descending; links and missing entries are left alone. */
const makeTreeWritable = async (path: string): Promise<void> => {
  try {
    const found = await lstat(path);
    if (found.isSymbolicLink()) return;
    if (found.isDirectory()) {
      if ((found.mode & 0o700) !== 0o700) await chmod(path, found.mode | 0o700);
      for (const entry of await readdir(path)) await makeTreeWritable(join(path, entry));
    } else if (process.platform === "win32" && (found.mode & 0o200) === 0) {
      // POSIX unlink needs access to the parent, even when another uid owns the file.
      await chmod(path, found.mode | 0o200);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/** Removes an owned tree, including read-only entries, without following links. */
export const removeTree = async (path: string): Promise<void> => {
  await makeTreeWritable(path);
  await rm(path, { recursive: true, force: true });
};

/** The same owner-access walk for callers whose rollback must finish synchronously. */
const makeWritableSync = (path: string): void => {
  try {
    const found = lstatSync(path);
    if (found.isSymbolicLink()) return;
    if (found.isDirectory()) {
      if ((found.mode & 0o700) !== 0o700) chmodSync(path, found.mode | 0o700);
      for (const entry of readdirSync(path)) makeWritableSync(join(path, entry));
    } else if (process.platform === "win32" && (found.mode & 0o200) === 0) {
      chmodSync(path, found.mode | 0o200);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/** Synchronous removal for rollback and staging callers; links are never followed. */
export const removeTreeSync = (path: string, remove: (path: string, options: { recursive: true; force: true }) => void = rmSync): void => {
  makeWritableSync(path);
  remove(path, { recursive: true, force: true });
};


/** Main, WAL and shm copies plus the reserve on their destination volume. */
export const snapshotNeeds = (dataDir: string, databaseFile: string, reserveBytes: number): number =>
  [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].reduce(
    (bytes, name) => bytes + (statSync(join(dataDir, name), { throwIfNoEntry: false })?.size ?? 0),
    reserveBytes,
  );

/** Conservative allocation for a copied tree; links are copied, never followed. */
export const treeCopyBytes = (path: string, blockSize: number): number => {
  const stat = lstatSync(path);
  const own = Math.max(blockSize, Math.ceil(stat.size / blockSize) * blockSize);
  return own + (stat.isDirectory() ? readdirSync(path).reduce((bytes, name) => bytes + treeCopyBytes(join(path, name), blockSize), 0) : 0);
};

/** The copy would leave too little room for activation; filesystem errors stay separate. */
export class CopySpaceError extends Error {}

/** Refuses a copy before it spends the room activation needs on the same volume. */
export const requireCopyRoom = (source: string, dataDir: string, databaseFile: string, reserveBytes: number): void => {
  const disk = statfsSync(dataDir);
  const needed = treeCopyBytes(realpathSync(source), disk.bsize) + snapshotNeeds(dataDir, databaseFile, reserveBytes);
  const free = disk.bavail * disk.bsize;
  if (free < needed) throw new CopySpaceError(`Not enough disk space: staging and the database snapshot need ${needed} bytes, but only ${free} bytes are free. Free space and try again.`);
};
