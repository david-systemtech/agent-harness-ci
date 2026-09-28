import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_VERSION_PATTERN, UPDATE_ID_PATTERN } from "@agent-harness/contracts/launcher";
import { writeFileDurably, type DurableFs } from "./durable.js";

/**
 * The service state (launcher-update spec, "Versions and the launcher"): one
 * file in the data directory naming the version the launcher runs and where an
 * update stands. While the service runs the launcher is its only writer;
 * `service install` writes it only when no launcher runs. Every write is
 * durable (`writeFileDurably`), and a state the launcher cannot read or
 * trust stops it starting anything.
 */

/** The service state's file in the data directory. */
export const SERVICE_STATE_FILE = "service-state.json";

/** An update the launcher has been asked to switch to and has not yet committed or rolled back. */
export interface PendingUpdate {
  readonly updateId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}

export interface ServiceState {
  /** The version whose `serve` the launcher runs. */
  readonly activeVersion: string;
  /** The version that was active before the last committed update, if there was one. */
  readonly previousVersion: string | null;
  /** The version whose launcher the service runs. */
  readonly launcherVersion: string;
  /** The update under way, if one is: written before the switch, cleared by its commit or its rollback. */
  readonly pendingUpdate: PendingUpdate | null;
  /** When the crash-loop watch after the last commit ends (an ISO 8601 time), if one is running. */
  readonly watchDeadline: string | null;
}

/** The service state, or why the launcher has none it can use. */
export type StateRead = { readonly state: ServiceState } | { readonly problem: string };

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isVersion = (value: unknown): value is string => typeof value === "string" && RELEASE_VERSION_PATTERN.test(value);
const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isPendingUpdate = (value: unknown): value is PendingUpdate =>
  isFields(value) &&
  typeof value["updateId"] === "string" &&
  UPDATE_ID_PATTERN.test(value["updateId"]) &&
  isVersion(value["fromVersion"]) &&
  isVersion(value["toVersion"]);

/** The state `value` holds, or which part of it is wrong. Parts it does not know are passed over. */
const stateOf = (value: unknown): ServiceState | string => {
  if (!isFields(value)) return "it is not an object";
  const { activeVersion, previousVersion, launcherVersion, pendingUpdate, watchDeadline } = value;
  if (!isVersion(activeVersion)) return "activeVersion is not a version";
  if (previousVersion !== null && !isVersion(previousVersion)) return "previousVersion is neither a version nor null";
  if (!isVersion(launcherVersion)) return "launcherVersion is not a version";
  if (pendingUpdate !== null && !isPendingUpdate(pendingUpdate)) return "pendingUpdate is neither a pending-update record nor null";
  if (watchDeadline !== null && !isTime(watchDeadline)) return "watchDeadline is neither a time nor null";
  return {
    activeVersion,
    previousVersion,
    launcherVersion,
    pendingUpdate: pendingUpdate === null ? null : { updateId: pendingUpdate.updateId, fromVersion: pendingUpdate.fromVersion, toVersion: pendingUpdate.toVersion },
    watchDeadline,
  };
};

/** The service state in `dataDir`, or why there is none to use: it is missing, cannot be read, or is not valid. */
export const readServiceState = (dataDir: string): StateRead => {
  const path = join(dataDir, SERVICE_STATE_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { problem: `there is no service state at ${path}` };
    return { problem: `the service state at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: `the service state at ${path} is not valid: it is not JSON` };
  }
  const state = stateOf(parsed);
  return typeof state === "string" ? { problem: `the service state at ${path} is not valid: ${state}` } : { state };
};

/** Writes `state` as the service state in `dataDir`, durably. */
export const writeServiceState = (dataDir: string, state: ServiceState, fs?: DurableFs): void =>
  writeFileDurably(join(dataDir, SERVICE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, fs);
