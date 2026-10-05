import { lstatSync, readdirSync, realpathSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Room left for migrations and writes beyond the database snapshot. */
export const SNAPSHOT_MARGIN_BYTES = 256 * 1024 * 1024;

/** Main, WAL and shm copies plus the reserve on their destination volume. */
export const snapshotNeeds = (dataDir: string, databaseFile: string): number =>
  [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].reduce(
    (bytes, name) => bytes + (statSync(join(dataDir, name), { throwIfNoEntry: false })?.size ?? 0),
    SNAPSHOT_MARGIN_BYTES,
  );

/** Conservative allocation for a copied tree; links are copied, never followed. */
export const treeCopyBytes = (path: string, blockSize: number): number => {
  const stat = lstatSync(path);
  const own = Math.max(blockSize, Math.ceil(stat.size / blockSize) * blockSize);
  return own + (stat.isDirectory() ? readdirSync(path).reduce((bytes, name) => bytes + treeCopyBytes(join(path, name), blockSize), 0) : 0);
};

/** Refuses a copy before it spends the room activation needs on the same volume. */
export const requireCopyRoom = (source: string, dataDir: string, databaseFile: string): void => {
  const disk = statfsSync(dataDir);
  const needed = treeCopyBytes(realpathSync(source), disk.bsize) + snapshotNeeds(dataDir, databaseFile);
  const free = disk.bavail * disk.bsize;
  if (free < needed) throw new Error(`Not enough disk space: staging and the database snapshot need ${needed} bytes, but only ${free} bytes are free. Free space and try again.`);
};
