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
  rmSync(path: string, options: { readonly force: true }): void;
}

/**
 * Replaces the file at `path` with `text` so that a power loss leaves either
 * the old file or the new one, never a torn one: a temporary file beside it,
 * fsynced, renamed over it, and the directory fsynced so the rename itself
 * survives. A failure before the rename removes the temporary file and leaves
 * the old one. Windows cannot fsync a directory, and NTFS journals the rename
 * on its own, so there the last step is left out.
 */
export const writeFileDurably = (path: string, text: string, fs: DurableFs = nodeFs, platform: NodeJS.Platform = process.platform): void => {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, path);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  if (platform === "win32") return;
  const directoryFd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
};
