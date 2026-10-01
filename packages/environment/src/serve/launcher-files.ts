import { rmSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_RECORD_FILE, RESTORE_MARKER_FILE, STAGING_DIRECTORY, isOutcomeRecord, type OutcomeRecord } from "@agent-harness/contracts";
import { readJsonFile } from "./files.js";

/**
 * The files in the data directory the environment shares with its launcher,
 * as the contracts' launcher module defines them. Of everything the launcher
 * owns there (the versions, its state, the snapshots, the entry), the
 * environment writes only the staging area, and deletes only the outcome
 * record, once it has settled the update the record reports.
 */

/** The staging area in `dataDir`: where the environment unpacks a version before `install?` names its folder. */
export const stagingArea = (dataDir: string): string => join(dataDir, STAGING_DIRECTORY);

/** Refuses an unfinished restore before the environment opens the database; only the launcher or `update restore` may finish it. */
export const refuseMarkedRestore = (dataDir: string): void => {
  const path = join(dataDir, RESTORE_MARKER_FILE);
  let record: OutcomeRecord | undefined;
  try {
    record = readJsonFile(path, isOutcomeRecord, "a restore marker");
  } catch (cause) {
    throw new Error(`The restore marker at ${path} cannot be read; check it before running agent-harness update restore to finish the restore.`, { cause });
  }
  if (record !== undefined) throw new Error(`The restore of update ${record.updateId} is unfinished; run agent-harness update restore to finish it before starting the environment.`);
};

/** The outcome record the launcher left in `dataDir`, or undefined when there is none. A file that is not one is refused, naming it. */
export const readOutcomeRecord = (dataDir: string): OutcomeRecord | undefined =>
  readJsonFile(join(dataDir, OUTCOME_RECORD_FILE), isOutcomeRecord, "an update's outcome record");

/** Deletes the outcome record in `dataDir` once its update is settled; none there is fine. */
export const deleteOutcomeRecord = (dataDir: string): void => rmSync(join(dataDir, OUTCOME_RECORD_FILE), { force: true });
