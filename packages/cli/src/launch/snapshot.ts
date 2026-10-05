import { snapshotNeeds as databaseSnapshotNeeds } from "@agent-harness/filesystem";
import * as nodeFs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_FILE, INSTALL_RESERVE_BYTES, isOutcomeRecord, OUTCOME_RECORD_FILE, RESTORE_MARKER_FILE, UPDATE_ID_PATTERN, type OutcomeRecord } from "@agent-harness/contracts/launcher";
import { createFileDurably, syncDirectory, syncFile, writeFileDurably, type DurableFs } from "./durable.js";

/**
 * The database snapshot and its restore (launcher-update spec, "Trial,
 * commit, rollback and the watch"; ADR 0007): what makes a failed update cost
 * a restart and never the log. Before an update's target runs, its database's
 * main, WAL and shm files are copied into a folder named by the update id;
 * rolling the update back copies them back under the restore marker, which
 * lets a restore cut short be finished, and leaves the outcome record the
 * environment settles the update from.
 *
 * Each call works on the data directory alone, with no launcher running and
 * no environment holding the database: the launcher calls them around a
 * trial, and the container's `update snapshot` and `update restore` verbs
 * (#349) call them the same way. Node's built-ins only, as the launcher
 * loads nothing else.
 */

/** The folder in the data directory holding one snapshot per update, named by its id. */
export const SNAPSHOTS_DIRECTORY = "snapshots";

/**
 * The restore marker, a file in the data directory: there from before the
 * first file of a restore is copied back until the restore has written its
 * outcome record, and holding that record, so a restore cut short is
 * finished before anything opens the database again.
 */
export { RESTORE_MARKER_FILE } from "@agent-harness/contracts/launcher";

/** The room a snapshot leaves free beyond its copy, for the target's migrations and whatever else writes meanwhile. */
export const SNAPSHOT_MARGIN_BYTES = INSTALL_RESERVE_BYTES;

/** The database's files, in the order they are copied: the main file, and the WAL and shm files SQLite keeps beside it in WAL mode. */
const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`] as const;

/** The file calls that change something: node's own, or a recording double in tests. */
export interface SnapshotFs extends DurableFs {
  copyFileSync(from: string, to: string): void;
  mkdirSync(path: string, options: { readonly recursive: true }): void;
}

export interface SnapshotOptions {
  /** Preset: node's own. */
  readonly fs?: SnapshotFs;
  /** The platform, which says whether a directory can be fsynced. Preset: this one. */
  readonly platform?: NodeJS.Platform;
}

export interface RestoreOptions extends SnapshotOptions {
  /**
   * Runs once the outcome record is written, while the restore is still
   * marked: the launcher clears its pending-update record here, so a restore
   * it is killed in is finished, and never begun again, at its next start.
   * A throw leaves the restore marked.
   */
  readonly whileMarked?: (record: OutcomeRecord) => void;
}

/** The folder the snapshot of the update `updateId` is in. Throws for anything but an update id, which is all a folder here is named by. */
export const snapshotDirectory = (dataDir: string, updateId: string): string => {
  if (!UPDATE_ID_PATTERN.test(updateId)) throw new Error(`${JSON.stringify(updateId)} is not an update id, so no snapshot is named by it.`);
  return join(dataDir, SNAPSHOTS_DIRECTORY, updateId);
};

/** Where the snapshot of `updateId` is copied before the rename that completes it. */
const stagingDirectory = (dataDir: string, updateId: string): string => `${snapshotDirectory(dataDir, updateId)}.staging`;

/** Whether the snapshot of `updateId` is complete in `dataDir`. */
export const hasSnapshot = (dataDir: string, updateId: string): boolean => existsSync(snapshotDirectory(dataDir, updateId));

/** The free bytes a snapshot of the database in `dataDir` needs: the size of its files, and the margin. */
export const snapshotNeeds = (dataDir: string): number =>
  databaseSnapshotNeeds(dataDir, DATABASE_FILE, SNAPSHOT_MARGIN_BYTES);

/**
 * Snapshots the database in `dataDir` for the update `updateId`, once:
 * whichever of its files exist are copied into a staging folder and put on
 * disk, and the folder is renamed to the update's, which completes it. A
 * completed snapshot is kept as it is (`kept`), never overwritten; a staging
 * folder left by one cut short is no snapshot, and is replaced. Nothing may
 * hold the database meanwhile.
 */
export const takeSnapshot = (dataDir: string, updateId: string, options: SnapshotOptions = {}): "taken" | "kept" => {
  const { fs = nodeFs, platform } = options;
  const snapshot = snapshotDirectory(dataDir, updateId);
  if (existsSync(snapshot)) return "kept";
  const staging = stagingDirectory(dataDir, updateId);
  fs.rmSync(staging, { force: true, recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const name of DATABASE_FILES) {
    if (!existsSync(join(dataDir, name))) continue;
    fs.copyFileSync(join(dataDir, name), join(staging, name));
    syncFile(join(staging, name), fs);
  }
  syncDirectory(staging, fs, platform);
  fs.renameSync(staging, snapshot);
  syncDirectory(join(dataDir, SNAPSHOTS_DIRECTORY), fs, platform);
  // The first snapshot made the snapshots folder, whose own name is in the data directory.
  syncDirectory(dataDir, fs, platform);
  return "taken";
};

/** Removes the snapshot of `updateId` and any staging folder one cut short left, and nothing else. */
export const discardSnapshot = (dataDir: string, updateId: string): void => {
  for (const folder of [stagingDirectory(dataDir, updateId), snapshotDirectory(dataDir, updateId)]) nodeFs.rmSync(folder, { force: true, recursive: true });
};

/** Writes `record` as the outcome record in `dataDir`, durably, for the environment to settle its update from. */
export const writeOutcomeRecord = (dataDir: string, record: OutcomeRecord, options: SnapshotOptions = {}): void =>
  writeFileDurably(join(dataDir, OUTCOME_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, options.fs, options.platform);

/** Throws unless the snapshot of `updateId` is complete: restoring from nothing would remove the database. */
const needSnapshot = (dataDir: string, updateId: string): void => {
  if (!hasSnapshot(dataDir, updateId)) throw new Error(`There is no snapshot of update ${updateId} in ${join(dataDir, SNAPSHOTS_DIRECTORY)} to restore.`);
};

/** Copies the snapshot of `record`'s update back over the database, writes the record as the outcome record, and clears the marker. */
const finish = (dataDir: string, record: OutcomeRecord, options: RestoreOptions): void => {
  const { fs = nodeFs, platform, whileMarked } = options;
  needSnapshot(dataDir, record.updateId);
  const snapshot = snapshotDirectory(dataDir, record.updateId);
  for (const name of DATABASE_FILES) {
    // A WAL or shm the snapshot lacks would hold the failed version's writes, which SQLite would replay over the copy.
    if (!existsSync(join(snapshot, name))) {
      fs.rmSync(join(dataDir, name), { force: true });
      continue;
    }
    fs.copyFileSync(join(snapshot, name), join(dataDir, name));
    syncFile(join(dataDir, name), fs);
  }
  syncDirectory(dataDir, fs, platform);
  writeOutcomeRecord(dataDir, record, options);
  whileMarked?.(record);
  fs.rmSync(join(dataDir, RESTORE_MARKER_FILE), { force: true });
  syncDirectory(dataDir, fs, platform);
};

/** The restore marked in `dataDir`, or undefined when none is. A marker that is not an outcome record throws, naming it. */
export const markedRestore = (dataDir: string): OutcomeRecord | undefined => {
  const path = join(dataDir, RESTORE_MARKER_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let marked: unknown;
  try {
    marked = JSON.parse(text);
  } catch {
    marked = undefined;
  }
  if (!isOutcomeRecord(marked)) throw new Error(`The restore marker at ${path} is not an outcome record, so the restore it marks cannot be finished.`);
  return marked;
};

/**
 * Rolls the database in `dataDir` back to the snapshot of `record`'s update,
 * in this order: the restore marker, holding `record`, is created
 * exclusively and put on disk; the snapshot's files are copied back and any
 * WAL or shm it lacks removed, and all of it put on disk; `record` is written
 * as the outcome record; `whileMarked` runs; the marker is cleared. Nothing
 * may hold the database meanwhile. It does not begin without a snapshot of
 * the update, or while another restore is marked (`finishMarkedRestore`).
 */
export const restoreSnapshot = (dataDir: string, record: OutcomeRecord, options: RestoreOptions = {}): void => {
  needSnapshot(dataDir, record.updateId);
  try {
    createFileDurably(join(dataDir, RESTORE_MARKER_FILE), `${JSON.stringify(record, null, 2)}\n`, options.fs, options.platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`A restore of update ${markedRestore(dataDir)?.updateId ?? "unknown"} is marked and not finished, so another cannot begin.`, { cause: error });
  }
  finish(dataDir, record, options);
};

/**
 * Finishes the restore marked in `dataDir`, if one is, from its copy on (the
 * copy is whole again however far it got), and answers the outcome record
 * the marker held; undefined, touching nothing, when none is marked. A
 * marked restore whose snapshot is gone is left marked, and throws.
 */
export const finishMarkedRestore = (dataDir: string, options: RestoreOptions = {}): OutcomeRecord | undefined => {
  const record = markedRestore(dataDir);
  if (record !== undefined) finish(dataDir, record, options);
  return record;
};
