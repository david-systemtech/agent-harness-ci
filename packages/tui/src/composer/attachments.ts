/**
 * A path on disk, or bytes already in hand, turned into something a message
 * can carry.
 *
 * Carried from Artemis's `apps/tui/src/attachments.ts` at 443cf2e
 * (docs/specs/tui.md, "Testing Decisions": the pure modules carried with their
 * tests), producing the harness's wire type instead of Artemis's.
 *
 * A terminal takes an attachment as a path (`/attach <path>`) or from the
 * clipboard (`Ctrl+V`). This reads it, decides whether it is an image the
 * providers accept or a file, and produces an `AttachmentInput` from
 * `@agent-harness/contracts`: its kind, its name, its media type and its bytes
 * in base64, sent with the text of `runs.start` or `runs.send`. The
 * environment keeps the bytes for the run and logs only the kind, the name,
 * the media type and the size. The path is read on the machine the terminal
 * UI runs on, whichever environment the session is on.
 *
 * Images are recognised by extension against the four media types the
 * providers accept. Everything else is a file, with the media type its
 * extension implies, or `application/octet-stream` when it implies none,
 * since the wire type always carries one. The size cap is the wire's own,
 * `MAX_ATTACHMENT_BYTES`, which keeps a mistyped path to a disk image from
 * becoming a hundred-megabyte prompt; and a name is cut to the wire's 255
 * characters.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import { MAX_ATTACHMENT_BYTES, type AttachmentInput } from "@agent-harness/contracts";

const IMAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const FILE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/** A file's media type when its extension says nothing: bytes, and no more is claimed. */
export const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

/** The longest name the wire takes, in UTF-16 code units as it counts them. */
export const MAX_ATTACHMENT_NAME = 255;

/** A media type as the wire accepts one: `image/png`. */
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/i;

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
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: overCap(full, size) };

  let bytes: Buffer;
  try {
    bytes = await readFile(full);
  } catch {
    // Stat needs only the directory; reading needs the file. One that can be seen but not read is the same line.
    return { ok: false, reason: `${full} does not exist or cannot be read.` };
  }
  // A file that grew between the stat and the read is held to the cap as well: the wire refuses anything over it.
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, reason: overCap(full, bytes.byteLength) };

  const data = bytes.toString("base64");
  const extension = extname(full).toLowerCase();
  const name = fitName(basename(full));
  const image = IMAGE_BY_EXTENSION[extension];
  if (image !== undefined) return { ok: true, path: full, attachment: { kind: "image", name, mediaType: image, data } };
  const mediaType = FILE_BY_EXTENSION[extension] ?? UNKNOWN_MEDIA_TYPE;
  return { ok: true, path: full, attachment: { kind: "file", name, mediaType, data } };
}

/**
 * The same attachment, from bytes that are already in hand.
 *
 * A clipboard image has no path: `readClipboardImage` hands back PNG bytes and
 * a media type, and there is nothing on disk to stat. Everything after that is
 * identical to what `readAttachment` builds, so it is built here rather than
 * inline at the one call site — the size cap above all, which is the rule a
 * screenshot of a 6K display can actually reach. A media type the wire would
 * refuse is `application/octet-stream`, and an empty name is `attachment`, so
 * what comes back is always something the wire takes.
 *
 * `null` is over the cap, which the caller reports in one line.
 */
export function attachmentFromBytes(name: string, mediaType: string, bytes: Uint8Array): AttachmentInput | null {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
  const data = Buffer.from(bytes).toString("base64");
  const fitted = fitName(name.length === 0 ? "attachment" : name);
  const type = MEDIA_TYPE.test(mediaType) ? mediaType : UNKNOWN_MEDIA_TYPE;
  return { kind: isImageMediaType(type) ? "image" : "file", name: fitted, mediaType: type, data };
}

/** The four the providers accept, which is the same list `IMAGE_BY_EXTENSION` maps on to. */
const IMAGE_MEDIA_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function isImageMediaType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.includes(mediaType);
}

/**
 * A name cut to the wire's length, never through the middle of a surrogate
 * pair: half an emoji is not a character anyone can read back.
 */
function fitName(name: string): string {
  if (name.length <= MAX_ATTACHMENT_NAME) return name;
  const cut = name.slice(0, MAX_ATTACHMENT_NAME);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function overCap(full: string, size: number): string {
  return `${basename(full)} is ${String(Math.round(size / 1024 / 1024))} MB; the limit is ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`;
}
