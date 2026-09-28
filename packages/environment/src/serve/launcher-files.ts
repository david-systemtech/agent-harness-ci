import { rmSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_RECORD_FILE, STAGING_DIRECTORY, isOutcomeRecord, type OutcomeRecord } from "@agent-harness/contracts";
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

/** The outcome record the launcher left in `dataDir`, or undefined when there is none. A file that is not one is refused, naming it. */
export const readOutcomeRecord = (dataDir: string): OutcomeRecord | undefined =>
  readJsonFile(join(dataDir, OUTCOME_RECORD_FILE), isOutcomeRecord, "an update's outcome record");

/** Deletes the outcome record in `dataDir` once its update is settled; none there is fine. */
export const deleteOutcomeRecord = (dataDir: string): void => rmSync(join(dataDir, OUTCOME_RECORD_FILE), { force: true });
