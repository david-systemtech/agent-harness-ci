/**
 * A path on disk turned into something a message can carry.
 *
 * One of the pure modules carried with their tests (docs/specs/tui.md,
 * "Testing Decisions"), producing the harness's wire type.
 *
 * A terminal takes an attachment as a path (`/attach <path>`) or from the
 * clipboard (`Ctrl+V`). This reads the path on the machine the terminal UI
 * runs on, whichever environment the session is on, and hands its bytes to
 * the client runtime's `attachmentFromBytes`, which the window uses too: the
 * media type its extension implies, the image or file it is, the name cut to
 * the wire's length and the bytes in base64. The size cap is the wire's own,
 * `MAX_ATTACHMENT_BYTES`, which keeps a mistyped path to a disk image from
 * becoming a hundred-megabyte prompt: a file past it is not read.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { attachmentFromBytes, mediaTypeOf, overLimit } from "@agent-harness/client-runtime";
import { MAX_ATTACHMENT_BYTES, type AttachmentInput } from "@agent-harness/contracts";

export type ReadAttachmentResult =
  { readonly ok: true; readonly attachment: AttachmentInput; readonly path: string } | { readonly ok: false; readonly reason: string };

export interface ReadAttachmentOptions {
  /** What `~` stands for. The real home directory unless a test says otherwise. */
  readonly home?: string;
}

/**
 * `~` is expanded first, because every shell the path was ever typed into
 * expanded it: `/attach ~/shot.png` otherwise looked for a directory literally
 * named `~` under the working directory and reported the file missing.
 */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/**
 * The file at `path`, resolved against `cwd` after `~` is expanded, as an
 * attachment; or the reason it cannot be one, in a line meant to be shown as
 * it is: not there, not a file, unreadable, or over the cap.
 */
export async function readAttachment(path: string, cwd: string, options: ReadAttachmentOptions = {}): Promise<ReadAttachmentResult> {
  const full = resolve(cwd, expandHome(path.trim(), options.home ?? homedir()));
  let size: number;
  try {
    const info = await stat(full);
    if (!info.isFile()) return { ok: false, reason: `${full} is not a file.` };
    size = info.size;
  } catch {
    return { ok: false, reason: `${full} does not exist or cannot be read.` };
  }
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: overLimit(basename(full), size) };

  let bytes: Buffer;
  try {
    bytes = await readFile(full);
  } catch {
    // Stat needs only the directory; reading needs the file. One that can be seen but not read is the same line.
    return { ok: false, reason: `${full} does not exist or cannot be read.` };
  }
  // A file that grew between the stat and the read is held to the cap as well: the wire refuses anything over it.
  const name = basename(full);
  const attachment = attachmentFromBytes(name, mediaTypeOf(name), bytes);
  if (attachment === null) return { ok: false, reason: overLimit(name, bytes.byteLength) };
  return { ok: true, path: full, attachment };
}
