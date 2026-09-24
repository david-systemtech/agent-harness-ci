import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
 * message's directory is there only once every byte is on disk. A message's
 * attachments never change, so staging one again whose bytes are already
 * whole leaves them as they are; one whose bytes are not is replaced with the
 * old directory set aside, not removed, until the new one is in, so a crash
 * at any step leaves one of them whole. A write a crash cut short leaves a
 * partial directory, which `dropPartial` removes, and perhaps a set-aside
 * copy, which it puts back when nothing replaced it and removes otherwise.
 */

/** The stage's directory under the data directory. */
export const ATTACHMENTS_DIRECTORY = "attachments";

/** A message id as the environment mints them (`randomUUID`); nothing else names a directory here. */
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a write in progress names its directory. */
const PARTIAL_PREFIX = ".partial-";

/** How a replaced message's old directory is named while the new one is renamed in. */
const ASIDE_PREFIX = ".aside-";

export interface AttachmentStage {
  /** Stages a message's attachments, replacing any it had; every byte is on disk when it returns. Throws when it cannot, leaving nothing. */
  write(messageId: string, attachments: readonly AttachmentData[]): void;
  /** A message's attachments, rebuilt from the log's record of them; undefined when none are staged or what is staged is not whole. */
  read(messageId: string, records: readonly AttachmentRecord[]): AttachmentData[] | undefined;
  /** Removes a message's staged bytes, if it has any. */
  remove(messageId: string): void;
  /** The messages with bytes staged. */
  list(): string[];
  /** Clears up after writes a crash cut short: their partial directories go, and a set-aside copy goes back when nothing replaced it, else goes. */
  dropPartial(): void;
}

const checked = (messageId: string): string => {
  if (!MESSAGE_ID.test(messageId)) throw new Error(`${JSON.stringify(messageId)} is not a message id; no attachment is staged under it.`);
  return messageId;
};

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

/** Whether `target` holds exactly a file per attachment, each the attachment's size: what a whole write left. */
const isWhole = (target: string, attachments: readonly AttachmentData[]): boolean => {
  try {
    if (readdirSync(target).length !== attachments.length) return false;
    return attachments.every((attachment, index) => statSync(join(target, String(index))).size === attachment.data.byteLength);
  } catch {
    return false;
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
    // A message's attachments never change: bytes already staged whole for it are these, and stay as they are.
    if (isWhole(target, attachments)) return;
    const partial = join(directory, `${PARTIAL_PREFIX}${randomUUID()}`);
    const aside = join(directory, `${ASIDE_PREFIX}${messageId}`);
    try {
      ownDirectory(partial);
      attachments.forEach((attachment, index) => writeSynced(join(partial, String(index)), attachment.data));
      syncDirectory(partial);
      // What was staged is set aside, not removed, until the new bytes are in place: a crash between leaves one of
      // them whole, and `dropPartial` puts an aside copy back when nothing replaced it.
      rmSync(aside, { recursive: true, force: true });
      if (existsSync(target)) {
        renameSync(target, aside);
        syncDirectory(directory);
      }
      renameSync(partial, target);
      syncDirectory(directory);
      rmSync(aside, { recursive: true, force: true });
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      if (!existsSync(target) && existsSync(aside)) renameSync(aside, target);
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
    for (const name of entries(directory)) {
      if (name.startsWith(PARTIAL_PREFIX)) rmSync(join(directory, name), { recursive: true, force: true });
      if (!name.startsWith(ASIDE_PREFIX)) continue;
      // A replace a crash cut: the old copy goes back when the new one never arrived, and goes when it did.
      const target = join(directory, name.slice(ASIDE_PREFIX.length));
      if (existsSync(target)) rmSync(join(directory, name), { recursive: true, force: true });
      else renameSync(join(directory, name), target);
    }
  },
});
