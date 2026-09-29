import { existsSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_NAME, ReleaseVersion, UpdateId } from "@agent-harness/contracts";
import { DATABASE_FILE, OUTCOME_STAGES, type OutcomeRecord, type OutcomeStage } from "@agent-harness/contracts/launcher";
import { defaultDataDirectory, HARNESS_VERSION, holdDatabase } from "@agent-harness/environment";
import { parseOptions, UsageError } from "./args.js";
import { discardSnapshot, finishMarkedRestore, hasSnapshot, markedRestore, restoreSnapshot, snapshotDirectory, takeSnapshot } from "./launch/snapshot.js";
import { LocalFailure } from "./local-session.js";
import type { UpdateContext } from "./update.js";

/**
 * The `update` verbs a container's host-side updater runs on the stopped
 * container's volume (launcher-update spec, "Containers: the host-side
 * updater"; #349), from a one-off container of the old or the target image:
 * `update snapshot` takes the update's database snapshot before the
 * recreate, `update restore` rolls it back after a failed one, and `update
 * discard` lets it go after a good watch. They reach no environment: each
 * works on the data directory alone, through the launcher's own snapshot and
 * restore (`launch/snapshot.ts`), and writes nothing outside it.
 */

export const UPDATE_SNAPSHOT_USAGE = [
  `${PRODUCT_NAME} update snapshot --update-id <id> [--data-dir <path>]`,
  `${PRODUCT_NAME} update restore --update-id <id> --stage <trial|crash-loop> --reason <code> --to-version <version> [--data-dir <path>]`,
  `${PRODUCT_NAME} update discard --update-id <id> [--data-dir <path>]`,
] as const;

/** A reason's code, as an outcome record names a failure: lowercase letters, digits and hyphens, such as `health` (never a leading hyphen, which reads as a flag). */
const REASON_CODE = /^[a-z0-9][a-z0-9-]*$/;

/** The update id a verb takes, required: the update the host-side updater began, as `update status --json` names it. */
const updateIdOf = (value: string | undefined, verb: string): string => {
  const parsed = UpdateId.safeParse(value);
  if (!parsed.success) throw new UsageError(`update ${verb} takes --update-id, the id of the update the host-side updater began; got ${value || "none"}.`);
  return parsed.data;
};

/** The database's file in `dataDir`. */
const databaseIn = (dataDir: string): string => join(dataDir, DATABASE_FILE);

/** Whether two update ids are one, in whichever case each is written. */
const sameUpdate = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase();

/** Runs `work`, a call on the data directory's files, saying its failure as the verb's. */
const onFiles = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw new LocalFailure(error instanceof Error ? error.message : String(error), { cause: error });
  }
};

/**
 * `update snapshot --update-id <id>`: snapshots the database in the data
 * directory for the update, once, as the launcher does before a trial: its
 * main, WAL and shm files as the old version left them. It is refused while
 * an environment holds the database, with no database to snapshot, and
 * while a restore is marked, whose database is part copied back. The
 * database is held meanwhile, so nothing opens it during the copy.
 */
const snapshot = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, "update-id": { type: "string" } });
  const updateId = updateIdOf(values["update-id"], "snapshot");
  const dataDir = values["data-dir"] ?? defaultDataDirectory();
  const database = databaseIn(dataDir);
  if (!existsSync(database)) throw new LocalFailure(`There is no database in ${dataDir} to snapshot.`);
  const marked = onFiles(() => markedRestore(dataDir));
  if (marked !== undefined) throw new LocalFailure(`A restore of update ${marked.updateId} is marked and not finished: finish it with update restore before a snapshot is taken.`);
  const hold = onFiles(() => holdDatabase(database));
  if (hold === "held") throw new LocalFailure(`An environment holds the database in ${dataDir}: stop it before the snapshot is taken.`);
  let taken: "taken" | "kept";
  try {
    taken = onFiles(() => takeSnapshot(dataDir, updateId));
  } finally {
    hold.release();
  }
  const where = snapshotDirectory(dataDir, updateId);
  context.stdout(
    taken === "taken"
      ? `Took the snapshot of update ${updateId}'s database, in ${where}.\n`
      : `Kept the snapshot of update ${updateId} taken before, in ${where}: an update's database is snapshotted once.\n`,
  );
  return 0;
};

/** The stage, the reason and the version the update went to, as `update restore` takes them; a usage error for any it does not. */
const failureOf = (values: { readonly stage?: string | undefined; readonly reason?: string | undefined; readonly "to-version"?: string | undefined }) => {
  const { stage, reason } = values;
  if (!OUTCOME_STAGES.includes(stage as OutcomeStage)) throw new UsageError(`update restore takes --stage, trial or crash-loop, where the update failed; got ${stage || "none"}.`);
  if (reason === undefined || !REASON_CODE.test(reason)) {
    throw new UsageError(`update restore takes --reason, a short code of lowercase letters, digits and hyphens naming the failure, such as health; got ${reason || "none"}.`);
  }
  const toVersion = ReleaseVersion.safeParse(values["to-version"]);
  if (!toVersion.success) throw new UsageError(`update restore takes --to-version, the release version the update went to, without its v; got ${values["to-version"] || "none"}.`);
  return { stage: stage as OutcomeStage, reason, toVersion: toVersion.data };
};

/** What `update restore` says once `record`'s restore is done, a fresh one or one `cutShort` it finished: the rollback, and what reports it. */
const restored = (record: OutcomeRecord, dataDir: string, cutShort: boolean): string => {
  const done = cutShort
    ? `Finished the restore of update ${record.updateId} that was cut short, over the database in ${dataDir}, and`
    : `Restored the snapshot of update ${record.updateId} over the database in ${dataDir} and`;
  return `${done} wrote its outcome record (${record.stage}: ${record.reason}): the version it went from reports the failure at its next start.\n`;
};

/**
 * `update restore --update-id <id> --stage <stage> --reason <code>
 * --to-version <version>`: rolls the update back, as the launcher does after
 * a failed trial or a crash loop, run on the image of the version the update
 * went from: the update's snapshot is copied back over the database under
 * the restore marker, and the outcome record written, naming this version as
 * the one the update went from, so that version's settle reports the
 * failure with the stage and reason at its next start. A restore cut short
 * is finished by running the verb again, with the stage and reason it began
 * with, which its marker holds. It is refused while an environment holds the
 * database, and with no snapshot of the update.
 */
const restore = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, {
    "data-dir": { type: "string" },
    "update-id": { type: "string" },
    stage: { type: "string" },
    reason: { type: "string" },
    "to-version": { type: "string" },
  });
  const updateId = updateIdOf(values["update-id"], "restore");
  const { stage, reason, toVersion } = failureOf(values);
  const dataDir = values["data-dir"] ?? defaultDataDirectory();
  const hold = onFiles(() => holdDatabase(databaseIn(dataDir)));
  if (hold === "held") throw new LocalFailure(`An environment holds the database in ${dataDir}: stop it before the snapshot is restored.`);
  // Nothing may hold the database while its files are copied over, this verb's own connection included.
  hold.release();
  const finished = onFiles(() => finishMarkedRestore(dataDir));
  if (finished !== undefined) {
    context.stdout(restored(finished, dataDir, true));
    if (sameUpdate(finished.updateId, updateId)) return 0;
  }
  const record: OutcomeRecord = { updateId, fromVersion: HARNESS_VERSION, toVersion, stage, reason };
  onFiles(() => restoreSnapshot(dataDir, record));
  context.stdout(restored(record, dataDir, false));
  return 0;
};

/**
 * `update discard --update-id <id>`: removes the update's snapshot, and any
 * staging folder one cut short left, once it is no longer needed: after a
 * good watch, the target running. It touches nothing else, so it runs
 * whether or not an environment holds the database; it is refused while a
 * restore of the update is marked, which needs the snapshot to finish.
 */
const discard = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, "update-id": { type: "string" } });
  const updateId = updateIdOf(values["update-id"], "discard");
  const dataDir = values["data-dir"] ?? defaultDataDirectory();
  const marked = onFiles(() => markedRestore(dataDir));
  if (marked !== undefined && sameUpdate(marked.updateId, updateId)) {
    throw new LocalFailure(`A restore of update ${updateId} is marked and not finished, and needs its snapshot: finish it with update restore first.`);
  }
  const had = hasSnapshot(dataDir, updateId);
  onFiles(() => discardSnapshot(dataDir, updateId));
  context.stdout(had ? `Discarded the snapshot of update ${updateId}.\n` : `There was no snapshot of update ${updateId} to discard.\n`);
  return 0;
};

/** The verbs, by name, for `update` to run. */
export const SNAPSHOT_VERBS = { snapshot, restore, discard } as const;
