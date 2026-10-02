import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { BINARY_SNIFF_BYTES, FILE_UNDO_MAX_FILE_BYTES, type FileChangeUnrestorableReason } from "@agent-harness/contracts";

/**
 * A file as a change's snapshot reads it (switch-over spec, "File undo"):
 * a regular text file of at most 2 MiB is kept, its bytes and permission
 * bits; nothing there is absent; anything else cannot be restored, and says
 * why: binary when a NUL byte is in its first 8 KiB (git's test, as
 * `files.read` makes it), oversized past 2 MiB, unknown for anything but a
 * regular file or one that could not be read. A symlink is never followed.
 */
export type FileState =
  | { readonly kind: "absent" }
  | { readonly kind: "kept"; readonly bytes: Buffer; readonly mode: number }
  | { readonly kind: "unrestorable"; readonly reason: Extract<FileChangeUnrestorableReason, "unknown" | "binary" | "oversized"> };

const unrestorable = (reason: "unknown" | "binary" | "oversized"): FileState => ({ kind: "unrestorable", reason });

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT" || (error as NodeJS.ErrnoException | null)?.code === "ENOTDIR";

/** The file at `path` as it is now: see the module comment. */
export const readFileState = async (path: string): Promise<FileState> => {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return unrestorable("unknown");
    if (info.size > FILE_UNDO_MAX_FILE_BYTES) return unrestorable("oversized");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // One byte past the bound tells a file that grew since the look.
      const buffer = Buffer.allocUnsafe(FILE_UNDO_MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > FILE_UNDO_MAX_FILE_BYTES) return unrestorable("oversized");
      const bytes = Buffer.from(buffer.subarray(0, length));
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return unrestorable("binary");
      return { kind: "kept", bytes, mode: info.mode & 0o7777 };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : unrestorable("unknown");
  }
};

/** The digest a change keeps of what its call left: SHA-256, in hex. */
export const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
