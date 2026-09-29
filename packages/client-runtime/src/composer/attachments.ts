import { MAX_ATTACHMENT_BYTES, type AttachmentInput } from "@agent-harness/contracts";

/**
 * Bytes in hand turned into something a message can carry, as every
 * renderer's composer does it (docs/specs/tui.md, "The composer";
 * docs/specs/gui.md, "A session pane"): the terminal UI reads a path
 * (`/attach`) or its clipboard, the window a paste, a drop or the shell's
 * file dialog, and each hands the bytes here with the name they came under.
 *
 * The result is an `AttachmentInput` from `@agent-harness/contracts`: its
 * kind, its name, its media type and its bytes in base64, sent with the text
 * of `runs.start` or `runs.send`. The environment keeps the bytes for the run
 * and logs only the kind, the name, the media type and the size.
 *
 * An image is one of the four media types the providers accept; everything
 * else is a file. A name's extension gives its media type when nothing else
 * does (`mediaTypeOf`), `application/octet-stream` when it implies none,
 * since the wire type always carries one. The size cap is the wire's own,
 * `MAX_ATTACHMENT_BYTES`, and a name is cut to the wire's 255 characters.
 * Nothing here reads a disk or a clipboard, so the window's bundle runs it in
 * a browser tab as the terminal UI runs it under Node.
 */

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

/** The four the providers accept, which is the same list `IMAGE_BY_EXTENSION` maps on to. */
const IMAGE_MEDIA_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The media type a file's name implies by its extension, ignoring case; `application/octet-stream` when it implies none. */
export const mediaTypeOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  return IMAGE_BY_EXTENSION[extension] ?? FILE_BY_EXTENSION[extension] ?? UNKNOWN_MEDIA_TYPE;
};

/**
 * The attachment `bytes` make, under `name` and `mediaType`; `null` past the
 * cap, which the caller reports in one line (`overLimit`). A media type the
 * wire would refuse is `application/octet-stream`, and an empty name is
 * `attachment`, so what comes back is always something the wire takes.
 */
export const attachmentFromBytes = (name: string, mediaType: string, bytes: Uint8Array): AttachmentInput | null => {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
  const type = MEDIA_TYPE.test(mediaType) ? mediaType : UNKNOWN_MEDIA_TYPE;
  return { kind: IMAGE_MEDIA_TYPES.includes(type) ? "image" : "file", name: fitName(name.length === 0 ? "attachment" : name), mediaType: type, data: base64Of(bytes) };
};

/** The line for a file past the cap, `size` its length in bytes. */
export const overLimit = (name: string, size: number): string =>
  `${name} is ${String(Math.round(size / 1024 / 1024))} MB; the limit is ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`;

/**
 * A name cut to the wire's length, never through the middle of a surrogate
 * pair: half an emoji is not a character anyone can read back.
 */
const fitName = (name: string): string => {
  if (name.length <= MAX_ATTACHMENT_NAME) return name;
  const cut = name.slice(0, MAX_ATTACHMENT_NAME);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** How many bytes are encoded into one piece of the text before it is joined: a multiple of three, so only the last piece pads. */
const PIECE = 3 * 4096;

/** `bytes` in standard padded base64, as the wire carries them, with neither Node's `Buffer` nor the browser's `btoa`. */
const base64Of = (bytes: Uint8Array): string => {
  const pieces: string[] = [];
  for (let start = 0; start < bytes.length; start += PIECE) {
    const end = Math.min(start + PIECE, bytes.length);
    let piece = "";
    for (let at = start; at < end; at += 3) {
      const b = at + 1 < end ? (bytes[at + 1] ?? 0) : undefined;
      const c = at + 2 < end ? (bytes[at + 2] ?? 0) : undefined;
      const word = ((bytes[at] ?? 0) << 16) | ((b ?? 0) << 8) | (c ?? 0);
      piece +=
        BASE64.charAt(word >> 18) +
        BASE64.charAt((word >> 12) & 63) +
        (b === undefined ? "=" : BASE64.charAt((word >> 6) & 63)) +
        (c === undefined ? "=" : BASE64.charAt(word & 63));
    }
    pieces.push(piece);
  }
  return pieces.join("");
};
