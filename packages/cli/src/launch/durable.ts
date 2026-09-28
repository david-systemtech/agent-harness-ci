import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";

/** The file calls a durable write makes: node's own, or a recording double in tests. */
export interface DurableFs {
  openSync(path: string, flags: string, mode?: number): number;
  writeFileSync(fd: number, text: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  linkSync(existing: string, path: string): void;
  rmSync(path: string, options: { readonly force: true; readonly recursive?: boolean }): void;
}

/** Writes `text` to a new temporary file beside `path` and puts it on disk, answering the temporary file's path; a failure removes it. */
const writeTemporary = (path: string, text: string, fs: DurableFs): string => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return temporary;
};

/** Puts the file at `path` on disk: what was written to it, and its size. It is opened for writing, which Windows needs to flush a file. */
export const syncFile = (path: string, fs: DurableFs = nodeFs): void => {
  const fd = fs.openSync(path, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Puts the directory at `path` on disk, so the names made, renamed or removed
 * in it survive a power loss. Windows cannot fsync a directory, and NTFS
 * journals those changes on its own, so there it does nothing.
 */
export const syncDirectory = (path: string, fs: DurableFs = nodeFs, platform: NodeJS.Platform = process.platform): void => {
  if (platform === "win32") return;
  const fd = fs.openSync(path, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Replaces the file at `path` with `text` so that a power loss leaves either
 * the old file or the new one, never a torn one: a temporary file beside it,
 * fsynced, renamed over it, and the directory fsynced so the rename itself
 * survives. A failure before the rename removes the temporary file and leaves
 * the old one.
 */
export const writeFileDurably = (path: string, text: string, fs: DurableFs = nodeFs, platform: NodeJS.Platform = process.platform): void => {
  const temporary = writeTemporary(path, text, fs);
  try {
    fs.renameSync(temporary, path);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(dirname(path), fs, platform);
};

/**
 * Creates the file at `path` holding `text`, only if nothing is there (it
 * throws `EEXIST` otherwise), so that a power loss leaves it whole or absent:
 * a temporary file beside it, fsynced, hard-linked as `path` (which fails
 * when the name is taken), the temporary name removed, and the directory
 * fsynced.
 */
export const createFileDurably = (path: string, text: string, fs: DurableFs = nodeFs, platform: NodeJS.Platform = process.platform): void => {
  const temporary = writeTemporary(path, text, fs);
  try {
    fs.linkSync(temporary, path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  syncDirectory(dirname(path), fs, platform);
};
