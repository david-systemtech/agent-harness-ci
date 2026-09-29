import { attachmentFromBytes, mediaTypeOf, overLimit, type ShellContent, type ShellFile } from "@agent-harness/client-runtime";
import { MAX_ATTACHMENT_BYTES, type AttachmentInput } from "@agent-harness/contracts";

/**
 * What the window attaches (docs/specs/gui.md, "A session pane"): a file
 * chosen in the shell's dialog, one dropped on the composer or pasted into
 * it, and an image off the shell's clipboard, each turned into an attachment
 * by the runtime's `attachmentFromBytes`, or refused in one line past the
 * wire's cap. Whether the session's provider takes it is the composer's to
 * ask (`attachmentRefused`).
 */

/** An attachment read, or the line that says why the file is not one. */
export type Taken = { readonly attachment: AttachmentInput } | { readonly refused: string };

/** How many attachments one message carries: the wire's `runs.start` and `runs.send` take twenty. */
export const MAX_ATTACHMENTS = 20;

const fromBytes = (name: string, mediaType: string, size: number, bytes: Uint8Array | null): Taken => {
  const attachment = bytes === null || size > MAX_ATTACHMENT_BYTES ? null : attachmentFromBytes(name, mediaType, bytes);
  return attachment === null ? { refused: overLimit(name, size) } : { attachment };
};

/** A file the shell's dialog read; one it left unread was past the cap. */
export const fromShellFile = (file: ShellFile): Taken => fromBytes(file.name, mediaTypeOf(file.name), file.size, file.bytes);

/** A file dropped or pasted into the window, read only when it is within the cap; its type is the browser's, else its name's. */
export const fromFile = async (file: File): Promise<Taken> =>
  fromBytes(file.name, file.type.length > 0 ? file.type : mediaTypeOf(file.name), file.size, file.size > MAX_ATTACHMENT_BYTES ? null : new Uint8Array(await file.arrayBuffer()));

/** The extension a pasted picture's name takes from its media type. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** The `number`th picture pasted off the shell's clipboard, named for it: `clipboard-1.png`. */
export const fromClipboardImage = (image: ShellContent, number: number): Taken =>
  fromBytes(`clipboard-${String(number)}${IMAGE_EXTENSIONS[image.mediaType] ?? ""}`, image.mediaType, image.bytes.byteLength, image.bytes);
