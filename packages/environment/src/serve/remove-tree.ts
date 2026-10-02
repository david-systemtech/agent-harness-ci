import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Restores owner access before descending; links and missing entries are left alone. */
export const makeTreeWritable = async (path: string): Promise<void> => {
  try {
    const found = await lstat(path);
    if (found.isSymbolicLink()) return;
    await chmod(path, found.mode | (found.isDirectory() ? 0o700 : 0o200));
    if (found.isDirectory()) for (const entry of await readdir(path)) await makeTreeWritable(join(path, entry));
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
    chmodSync(path, found.mode | (found.isDirectory() ? 0o700 : 0o200));
    if (found.isDirectory()) for (const entry of readdirSync(path)) makeWritableSync(join(path, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/** Synchronous removal for rollback and staging callers; links are never followed. */
export const removeTreeSync = (path: string, remove: (path: string, options: { recursive: true; force: true }) => void = rmSync): void => {
  makeWritableSync(path);
  remove(path, { recursive: true, force: true });
};
