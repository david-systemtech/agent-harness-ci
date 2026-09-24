import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Small file helpers for the state directory: every directory made readable
 * by its owner alone, every file written whole through a rename so a reader
 * (another terminal UI on the same state directory) never sees half of one.
 */

/** Makes `dir` and any missing parent, owner-only; an existing one is tightened to the same mode. */
export const ensurePrivateDirectory = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
};

let written = 0;

/** Writes `text` to `path` whole, owner-only: a temporary file beside it, then a rename over it. */
export const writePrivateFile = (path: string, text: string): void => {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${++written}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
};

/** The file's text, or undefined when there is no such file. */
export const readTextIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
