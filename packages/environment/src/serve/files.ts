import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replaces `path` with `content` all at once: a reader sees the old file or
 * the new one, never half of either. The temporary file is created with
 * `mode` beside the target, so the rename stays on one filesystem, and the
 * directory is synced after it, so the rename itself survives a power cut.
 */
export const writeFileAtomic = (path: string, content: string, mode: number): void => {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // Windows cannot open a directory to sync it; NTFS journals the rename.
  if (process.platform !== "win32") {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
};

/**
 * The JSON in `path` when it has the shape `isShape` accepts; undefined when
 * the file does not exist. A file that is not JSON, or not that shape, is
 * refused with `what` named, never treated as absent: the caller would
 * otherwise replace it.
 */
export const readJsonFile = <T>(path: string, isShape: (value: unknown) => value is T, what: string): T | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON, so it is not ${what}; refusing to read or replace it.`);
  }
  if (!isShape(parsed)) throw new Error(`${path} is not ${what}; refusing to read or replace it.`);
  return parsed;
};
