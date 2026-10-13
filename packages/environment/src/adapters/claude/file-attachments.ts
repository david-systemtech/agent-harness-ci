import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptMessage } from "../../adapter/contract.js";

/** A file's leaf name on either platform; a supplied path cannot leave the staging directory. */
const leafName = (name: string): string => {
  const leaf = (name.split(/[\\/]/).at(-1) ?? "").replace(/[<>:"|?*\p{Cc}]/gu, "_").replace(/[. ]+$/, "");
  if (leaf === "") return "attachment";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf) ? `_${leaf}` : leaf;
};

/**
 * Files Claude reads with its tools (#2103), retained with the session:
 * below its containment scratch directory, which purge and startup cleanup
 * already own. Each file gets a new directory, so duplicate names and a
 * message sent again never overwrite a file the provider has already read.
 * JSON quotes the metadata so a name cannot add another manifest entry.
 */
export const fileAttachmentText = (message: PromptMessage, scratchDirectory: string): string => {
  const files = message.attachments.filter((attachment) => attachment.kind === "file");
  if (files.length === 0) return message.text;
  const root = join(scratchDirectory, "attachments");
  mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(scratchDirectory).isSymbolicLink()) throw new Error("The session's scratch directory must not be a symbolic link.");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error("The session's attachment directory must not be a symbolic link.");
  const references = files.map((file) => {
    const directory = mkdtempSync(join(root, "file-"));
    const path = join(directory, leafName(file.name));
    writeFileSync(path, file.data, { mode: 0o600, flag: "wx" });
    return JSON.stringify({ path, mediaType: file.mediaType, size: file.data.byteLength });
  });
  return [message.text, "Attached files (read with file tools):", ...references].filter((part) => part !== "").join("\n");
};
