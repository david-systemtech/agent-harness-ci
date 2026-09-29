import { attachmentFromBytes, attachmentRefused, mediaTypeOf, overLimit, type CapabilityAnswer, type ShellContent, type ShellFile } from "@agent-harness/client-runtime";
import { MAX_ATTACHMENT_BYTES, type AdapterCapabilities, type AttachmentInput } from "@agent-harness/contracts";
import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useRuntime, useShell } from "../window-context.js";

/**
 * What the composer attaches (docs/specs/gui.md, "A session pane"; #400): a
 * file chosen in the shell's dialog, one dropped on the composer or pasted
 * into it, and an image off the shell's clipboard (Mod+V), each turned into
 * an attachment by the runtime's `attachmentFromBytes`, or refused in one
 * line past the wire's cap, and each asked whether the session's provider
 * takes it (`attachmentRefused`): one it refuses is said with its reason and
 * the others are kept. They show as chips until the message goes.
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

export interface AttachmentsHost {
  readonly environmentId: string;
  /** The session's provider, once known: what its input flags refuse is not attached. */
  readonly provider: AdapterCapabilities | undefined;
  /** The composer's one line. */
  readonly say: (line: string | undefined) => void;
  /** Text off the clipboard, typed where the caret is. */
  readonly insert: (text: string) => void;
}

export interface Attachments {
  readonly list: readonly AttachmentInput[];
  /** The list as it is now, for a paste or a dialog answered after the render that asked. */
  current(): readonly AttachmentInput[];
  set(next: readonly AttachmentInput[]): void;
  /** Whether the shell's file dialog can be opened, the capability's line when not. */
  readonly dialog: CapabilityAnswer;
  /** The shell's file dialog (Attach files, `/attach`), every file chosen read within the wire's cap. */
  choose(): void;
  /** Mod+V: an image off the shell's clipboard, else its text; `false` leaves the key to the page's paste without one. */
  paste(): false | void;
  /** The page's own paste (its context menu's, a browser tab's Mod+V): its files are attached, its text is the box's. */
  pasted(event: ClipboardEvent): void;
  dragging(event: DragEvent): void;
  dropped(event: DragEvent): void;
}

/** The attachments going with the next message, and the four ways they come. */
export const useAttachments = ({ environmentId, provider, say, insert }: AttachmentsHost): Attachments => {
  const runtime = useRuntime();
  const shell = useShell();
  const [list, setList] = useState<readonly AttachmentInput[]>([]);
  const now = useRef(list);
  const pastes = useRef(0);
  const set = (next: readonly AttachmentInput[]) => {
    now.current = next;
    setList(next);
  };

  /** Adds what was read, saying in one line what was refused and why; the others are kept. */
  const take = (candidates: readonly Taken[]) => {
    const refusals: string[] = [];
    let next = now.current;
    for (const candidate of candidates) {
      if ("refused" in candidate) {
        refusals.push(candidate.refused);
        continue;
      }
      const { attachment } = candidate;
      const refused = attachmentRefused(attachment, provider);
      if (refused !== undefined) refusals.push(refused);
      else if (next.length >= MAX_ATTACHMENTS) refusals.push(`A message carries at most ${String(MAX_ATTACHMENTS)} attachments: ${attachment.name} was not attached.`);
      else next = [...next, attachment];
    }
    set(next);
    say(refusals.length > 0 ? refusals.join(" ") : undefined);
  };
  const takeFiles = (files: readonly File[]) => void Promise.all(files.map(fromFile)).then(take);

  const dialog = runtime.capability(environmentId, "shell.dialogs");
  return {
    list,
    current: () => now.current,
    set,
    dialog,
    choose() {
      if (dialog.status === "absent") return say(dialog.message);
      void shell?.dialogs?.openFileContents({ title: "Attach files", multiple: true, maxBytes: MAX_ATTACHMENT_BYTES }).then((chosen) => take(chosen.map(fromShellFile)));
    },
    paste() {
      const clipboard = shell?.clipboard;
      if (clipboard === undefined || runtime.capability(environmentId, "shell.clipboard").status === "absent") return false;
      void (async () => {
        const image = await clipboard.readImage().catch(() => undefined);
        if (image !== undefined) return take([fromClipboardImage(image, ++pastes.current)]);
        const text = await clipboard.readText().catch(() => "");
        if (text.length > 0) return insert(text);
        say("The clipboard holds no image and no text.");
      })();
    },
    pasted(event) {
      const files = [...event.clipboardData.files];
      if (files.length === 0) return;
      event.preventDefault();
      takeFiles(files);
    },
    dragging(event) {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    dropped(event) {
      const files = [...event.dataTransfer.files];
      if (files.length === 0) return;
      event.preventDefault();
      takeFiles(files);
    },
  };
};

/** The attachments as chips, each with a way to take it off before sending. */
export const AttachmentChips = ({ attachments }: { readonly attachments: Attachments }) =>
  attachments.list.length === 0 ? null : (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {attachments.list.map((attachment, index) => (
        <li key={`${String(index)} ${attachment.name}`} className="flex items-center gap-1 rounded-full border border-line bg-raised py-0.5 pr-1 pl-2.5 text-xs text-ink">
          <span>{attachment.name}</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => attachments.set(attachments.current().filter((_, other) => other !== index))}
            className="rounded-full px-1 text-ink-muted hover:bg-wash hover:text-ink"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
