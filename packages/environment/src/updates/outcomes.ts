import {
  ENVIRONMENT_STREAM_KIND,
  EnvironmentUpdatedPayload,
  UpdateFailedPayload,
  UpdateStartedPayload,
  type OutcomeRecord,
  type UpdateFailureStage,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import type { EventInput, EventLog, StreamRef } from "../event-log/event-log.js";
import { deleteOutcomeRecord, readOutcomeRecord } from "../serve/launcher-files.js";

/**
 * How updates end (launcher-update spec, "The update coordinator", Settle;
 * #344). An update that began (`environment.update-started`) ends with one
 * outcome on the environment's stream: `environment.updated` once its target
 * runs, or `environment.update-failed` when the version it went from runs
 * again. A refused switch appends its own failure before the environment
 * closes; every other outcome is appended by the settle, as the next start
 * passes its gate, from the version that start runs and the outcome record
 * the launcher (or a container's `update restore`) left.
 */

/** The events an update's history is read from: its start, and the two outcomes. */
const HISTORY_TYPES = ["environment.update-started", "environment.updated", "environment.update-failed"] as const;

/**
 * The stages at which a version fails by itself, and is marked failed: its
 * trial, or the crash-loop watch after its commit. A refused switch, or one
 * that never came, says nothing of the version, which the channel may take
 * again (launcher-update spec, "The target").
 */
const VERSION_FAILURES: readonly UpdateFailureStage[] = ["trial", "crash-loop"];

/** The reason a failure is given when no outcome record says why. */
const UNKNOWN_REASON = "unknown";

/** What the log says of the updates that began. */
export interface UpdateHistory {
  /** The update that began last, and whether it has its outcome yet; undefined when none began. */
  readonly latest: { readonly started: UpdateStartedPayload; readonly settled: boolean } | undefined;
  /** How the last update ended, and the versions whose update failed, as `updates.status` answers them. */
  readonly outcomes: Pick<UpdatesStatus, "lastOutcome" | "failedVersions">;
}

/**
 * The history of the updates in `log`, read from the environment's stream in
 * order. A failed version stays marked until an update to it takes. A
 * payload that is not its event's is passed over.
 */
export const readUpdateHistory = (log: EventLog): UpdateHistory => {
  let latest: UpdateStartedPayload | undefined;
  const settled = new Set<string>();
  let lastOutcome: UpdatesStatus["lastOutcome"] = null;
  const failed = new Set<string>();
  for (const event of log.readStream({ kinds: [ENVIRONMENT_STREAM_KIND], types: [...HISTORY_TYPES] })) {
    if (event.type === "environment.update-started") {
      const started = UpdateStartedPayload.safeParse(event.payload);
      if (started.success) latest = started.data;
    } else if (event.type === "environment.updated") {
      const updated = EnvironmentUpdatedPayload.safeParse(event.payload);
      if (!updated.success) continue;
      const { updateId, fromVersion, toVersion } = updated.data;
      if (updateId !== undefined) settled.add(updateId);
      lastOutcome = { outcome: "updated", updateId: updateId ?? null, fromVersion, toVersion, at: event.occurredAt };
      failed.delete(toVersion);
    } else {
      const failure = UpdateFailedPayload.safeParse(event.payload);
      if (!failure.success) continue;
      settled.add(failure.data.updateId);
      lastOutcome = { outcome: "failed", ...failure.data, at: event.occurredAt };
      if (VERSION_FAILURES.includes(failure.data.stage)) failed.add(failure.data.toVersion);
    }
  }
  return {
    latest: latest && { started: latest, settled: settled.has(latest.updateId) },
    outcomes: { lastOutcome, failedVersions: [...failed] },
  };
};

export interface SettleOptions {
  readonly log: EventLog;
  /** The environment's own stream, where the outcome goes. */
  readonly stream: StreamRef;
  /** The data directory, where the launcher leaves the outcome record. */
  readonly dataDir: string;
  /** The version this start runs. */
  readonly harnessVersion: string;
  /** Who the outcome names. */
  readonly actor: string;
}

/** The outcome record in `dataDir` when it reports `updateId`; undefined when there is none, it reports another update, or it cannot be read (said on standard error). */
const recordOf = (dataDir: string, updateId: string): OutcomeRecord | undefined => {
  let record: OutcomeRecord | undefined;
  try {
    record = readOutcomeRecord(dataDir);
  } catch (error) {
    console.error(`The outcome record could not be read, so update ${updateId} is settled with the reason ${UNKNOWN_REASON}:`, error);
    return undefined;
  }
  return record?.updateId.toLowerCase() === updateId.toLowerCase() ? record : undefined;
};

/**
 * The outcome of `started`, which this start settles. Running its target,
 * the update took. Otherwise it failed, at the stage and for the reason the
 * outcome record gives, rolled back; with no record of it no rollback wrote
 * one, so the switch never came (a drain cut short by a stop, a power loss)
 * and the version it went from ran on: stage `switch`, reason `unknown`.
 */
const outcomeOf = (started: UpdateStartedPayload, options: SettleOptions): EventInput => {
  const { updateId, fromVersion, toVersion } = started;
  if (options.harnessVersion === toVersion) {
    const payload: EnvironmentUpdatedPayload = { fromVersion, toVersion, updateId };
    return { type: "environment.updated", payload };
  }
  const record = recordOf(options.dataDir, updateId);
  const payload: UpdateFailedPayload = record
    ? { updateId, fromVersion, toVersion, stage: record.stage, reason: record.reason, rolledBack: true }
    : { updateId, fromVersion, toVersion, stage: "switch", reason: UNKNOWN_REASON, rolledBack: false };
  return { type: "environment.update-failed", payload };
};

/**
 * The settle's outcome, as a start passes its gate: the update that began
 * last gets its outcome when it has none yet, and then the outcome record
 * is deleted, whatever update it reports, since only the latest is ever
 * settled. Each half holds on its own: a start after a stop between the two
 * appends nothing and deletes the record. A failed append leaves the record
 * for the next start; neither failure stops this one.
 */
export const settleLatestUpdate = (options: SettleOptions): void => {
  const { latest } = readUpdateHistory(options.log);
  if (latest === undefined) return;
  if (!latest.settled) {
    try {
      options.log.append(options.stream, [outcomeOf(latest.started, options)], { actor: options.actor });
    } catch (error) {
      console.error(`Settling update ${latest.started.updateId} failed; the next start settles it:`, error);
      return;
    }
  }
  try {
    deleteOutcomeRecord(options.dataDir);
  } catch (error) {
    console.error("Deleting the outcome record failed; the next start deletes it:", error);
  }
};
