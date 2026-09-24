import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

/**
 * Replaces `path` with `content` all at once: a reader sees the old file or
 * the new one, never half of either. The temporary file is created with
 * `mode` and beside the target, so the rename stays on one filesystem.
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
};
