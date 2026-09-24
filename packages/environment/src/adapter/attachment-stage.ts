import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttachmentRecord } from "@agent-harness/contracts";
import type { AttachmentData } from "./contract.js";

/**
 * The attachment stage (claude-adapter spec, #185's notes): where the bytes
 * of a queued message's attachments wait until a run reads them, so a
 * restart keeps them. A directory of the environment's own under its data
 * directory (`attachments/`), holding one directory per message named by its
 * id, and in it one file per attachment named by its index: the bytes alone,
 * since the log's `message.sent` records each attachment's kind, name, media
 * type and size, and never the bytes. Directories are 0700 and files 0600.
 *
 * A write is whole or nothing: the files go to a partial directory, each
 * synced, which is then renamed into place and the rename synced, so a
 * message's directory is there only once every byte is on disk. A write a
 * crash cut short leaves a partial directory, which `dropPartial` removes.
 */

/** The stage's directory under the data directory. */
export const ATTACHMENTS_DIRECTORY = "attachments";

/** A message id as the environment mints them (`randomUUID`); nothing else names a directory here. */
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a write in progress names its directory. */
const PARTIAL_PREFIX = ".partial-";

export interface AttachmentStage {
  /** Stages a message's attachments, replacing any it had; every byte is on disk when it returns. Throws when it cannot, leaving nothing. */
  write(messageId: string, attachments: readonly AttachmentData[]): void;
  /** A message's attachments, rebuilt from the log's record of them; undefined when none are staged or what is staged is not whole. */
  read(messageId: string, records: readonly AttachmentRecord[]): AttachmentData[] | undefined;
  /** Removes a message's staged bytes, if it has any. */
  remove(messageId: string): void;
  /** The messages with bytes staged. */
  list(): string[];
  /** Removes what a write cut short by a crash left behind. */
  dropPartial(): void;
}

const checked = (messageId: string): string => {
  if (!MESSAGE_ID.test(messageId)) throw new Error(`${JSON.stringify(messageId)} is not a message id; no attachment is staged under it.`);
  return messageId;
};

/** A directory readable by its owner alone, made if it is missing. */
/**
 * Makes `path` a 0700 directory of the environment's own. A directory made
 * here is synced into its parent, since a new directory entry is durable
 * only once the parent is: the receipt promises the bytes survive a crash,
 * and the first stage on a fresh environment creates the root itself.
 */
const ownDirectory = (path: string): void => {
  const missing: string[] = [];
  for (let ancestor = path; !existsSync(ancestor); ancestor = dirname(ancestor)) missing.unshift(ancestor);
  for (const directory of missing) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(dirname(directory));
  }
  if (process.platform !== "win32") chmodSync(path, 0o700);
};

/** Writes `data` to a new 0600 file and syncs it. */
const writeSynced = (path: string, data: Uint8Array): void => {
  const fd = openSync(path, "wx", 0o600);
  try {
    for (let written = 0; written < data.byteLength; ) written += writeSync(fd, data, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Syncs a directory's entries, so a rename in it survives a crash; not every platform can. */
const syncDirectory = (path: string): void => {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const entries = (directory: string): string[] => {
  try {
    return readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

/** The stage in `directory`, made on its first write. */
export const createAttachmentStage = (directory: string): AttachmentStage => ({
  write(messageId, attachments) {
    const target = join(directory, checked(messageId));
    ownDirectory(directory);
    const partial = join(directory, `${PARTIAL_PREFIX}${randomUUID()}`);
    try {
      ownDirectory(partial);
      attachments.forEach((attachment, index) => writeSynced(join(partial, String(index)), attachment.data));
      syncDirectory(partial);
      rmSync(target, { recursive: true, force: true });
      renameSync(partial, target);
      syncDirectory(directory);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  },
  read(messageId, records) {
    const source = join(directory, checked(messageId));
    const read: AttachmentData[] = [];
    for (const [index, record] of records.entries()) {
      let data: Buffer;
      try {
        data = readFileSync(join(source, String(index)));
      } catch {
        return undefined;
      }
      if (data.byteLength !== record.size) return undefined;
      read.push({ kind: record.kind, name: record.name, mediaType: record.mediaType, data: new Uint8Array(data) });
    }
    return read;
  },
  remove(messageId) {
    rmSync(join(directory, checked(messageId)), { recursive: true, force: true });
  },
  list: () => entries(directory).filter((name) => MESSAGE_ID.test(name)),
  dropPartial() {
    for (const name of entries(directory)) if (name.startsWith(PARTIAL_PREFIX)) rmSync(join(directory, name), { recursive: true, force: true });
  },
});
