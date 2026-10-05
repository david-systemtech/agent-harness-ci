import type { EnvironmentReadiness } from "./discovery.js";
import type { BusyReason, DrainStarted, DrainTrigger, EnvironmentStatus } from "./lifecycle.js";

/** Free space reserved for a version to run, also left beyond a database snapshot. */
export const INSTALL_RESERVE_BYTES = 256 * 1024 * 1024;

/**
 * What the environment and its launcher share (launcher-update spec, "The
 * channel" and "Versions and the launcher"): the messages on the IPC channel
 * the launcher spawns the environment with, the files in the data directory
 * both of them touch, and the report a version's `preflight` prints for the
 * launcher. This is their one definition. It is plain
 * data and loads nothing at run time (every import above is a type), so the
 * launcher, which runs on Node's built-ins, reads it alone through
 * `@agent-harness/contracts/launcher`.
 *
 * The channel carries requests both ways, each answered once. The launcher
 * asks `idle?` (answered `idle` with the status document) and `drain?`
 * (answered `draining` with how the drain began). The environment says
 * `prepared {version}` once its startup gate is passed, and the launcher
 * answers `committed`; it asks `install? {version, staged}` (answered
 * `installed` or `refused`), `switch? {updateId, version}` (`switching` or
 * `refused`) and `versions?` (`versions`). The environment's requests carry
 * an id their answer repeats, since several may be outstanding at once. A
 * message either side does not know is read as nothing and ignored, never an
 * error.
 */

/**
 * The launcher protocol these messages and files are: one integer, raised on
 * a change a launcher must understand. Each release's environment runs under
 * the previous release's launcher, so a breaking change ships across two
 * releases, and `install?` refuses a version that needs a higher one.
 */
export const LAUNCHER_PROTOCOL = 1;

/**
 * A release's version, SemVer 2.0.0 without the tag's `v`: major, minor and
 * patch without leading zeros, then an optional prerelease and build part.
 * The launcher names each installed version's folder by it, so it is defined
 * here, where the launcher reads it, and the release's schema takes it from here.
 */
export const RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** A release version's parts: its three numbers, its prerelease identifiers (none for a release), its build metadata left out. */
const partsOf = (version: string): { readonly numbers: readonly string[]; readonly prerelease: readonly string[] } => {
  const core = version.split("+", 1)[0] ?? "";
  const dash = core.indexOf("-");
  const numbers = (dash === -1 ? core : core.slice(0, dash)).split(".");
  return { numbers, prerelease: dash === -1 ? [] : core.slice(dash + 1).split(".") };
};

const NUMERIC = /^\d+$/;

/** Two digit strings without leading zeros, compared as numbers of any length. */
const compareNumbers = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** Two prerelease identifiers: numbers numerically and below any alphanumeric one, which compare in ASCII order. */
const compareIdentifiers = (a: string, b: string): number => {
  const [numericA, numericB] = [NUMERIC.test(a), NUMERIC.test(b)];
  if (numericA && numericB) return compareNumbers(a, b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Two release versions by SemVer precedence: below zero when `a` comes
 * before `b`, above when after, zero when they are equal in precedence
 * (build metadata is ignored). A prerelease comes before its release; its
 * identifiers compare one by one, and a longer set comes after its prefix.
 * Both must be release versions (`RELEASE_VERSION_PATTERN`). Defined here,
 * where the launcher reads it to keep the versions before the active one.
 */
export const compareReleaseVersions = (a: string, b: string): number => {
  const [left, right] = [partsOf(a), partsOf(b)];
  for (let index = 0; index < 3; index++) {
    const order = compareNumbers(left.numbers[index] ?? "0", right.numbers[index] ?? "0");
    if (order !== 0) return order;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) return right.prerelease.length - left.prerelease.length;
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const order = compareIdentifiers(left.prerelease[index] ?? "", right.prerelease[index] ?? "");
    if (order !== 0) return order;
  }
  return left.prerelease.length - right.prerelease.length;
};

/** Whether a release version has a prerelease part: only the beta channel follows one. */
export const isPrerelease = (version: string): boolean => partsOf(version).prerelease.length > 0;

/**
 * An update's id, as the launcher reads it: a version 4 UUID, in either case
 * (the update vocabulary's `UpdateId`, which takes the same). The launcher
 * names the update's database snapshot by it, so `switch?` and the outcome
 * record take nothing else.
 */
export const UPDATE_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * How long the environment's drain waits for running runs before it cuts
 * them (ADR 0007). The launcher waits a minute past it for a child that it
 * answered `switching` to exit, and then ends it.
 */
export const DRAIN_CAP_MS = 30 * 60_000;

/** The launcher's queries: whether the environment is idle, and to drain. */
export type LauncherQuery = { readonly type: "idle?" } | { readonly type: "drain?" };

/** The environment's reply to a `LauncherQuery`: its status document, or how the drain began (or the one under way). */
export type LauncherReply = ({ readonly type: "idle" } & EnvironmentStatus) | ({ readonly type: "draining" } & DrainStarted);

/** The environment's startup gate is passed, running `version`: the launcher answers `committed` once it has committed that version. */
export interface PreparedMessage {
  readonly type: "prepared";
  readonly version: string;
}

/** The launcher has committed the version that said `prepared`: the environment may now serve. */
export interface CommittedMessage {
  readonly type: "committed";
}

/**
 * What the environment asks the launcher: to install the version unpacked at
 * `staged` in the staging area, to switch to an installed version for an
 * update, or which versions are installed.
 */
export type EnvironmentRequest =
  | { readonly type: "install?"; readonly version: string; readonly staged: string }
  | { readonly type: "switch?"; readonly updateId: string; readonly version: string }
  | { readonly type: "versions?" };

/**
 * Why the launcher refuses an install: the version needs a higher launcher
 * protocol than it speaks, the staged folder is not a whole version, its
 * preflight failed or timed out, the disk is too full, or a write failed.
 */
export const INSTALL_REFUSALS = ["launcher-protocol", "incomplete", "preflight", "disk", "io"] as const;
export type InstallRefusal = (typeof INSTALL_REFUSALS)[number];

/**
 * Why the launcher refuses a switch: the version is not installed, the disk
 * has no room for the database's snapshot, or a write failed.
 */
export const SWITCH_REFUSALS = ["not-installed", "disk", "io"] as const;
export type SwitchRefusal = (typeof SWITCH_REFUSALS)[number];

/** The launcher's answer to `install?`. */
export type InstallAnswer = { readonly type: "installed" } | { readonly type: "refused"; readonly reason: InstallRefusal };

/** The launcher's answer to `switch?`: after `switching` the environment closes, the channel last. */
export type SwitchAnswer = { readonly type: "switching" } | { readonly type: "refused"; readonly reason: SwitchRefusal };

/** The launcher's answer to `versions?`: the versions installed, its own version and protocol, and any failed handover's target. */
export interface VersionsAnswer {
  readonly type: "versions";
  readonly installed: readonly string[];
  readonly launcherVersion: string;
  readonly launcherProtocol: number;
  /** The version whose launcher handover failed, if any; absent on older launchers. */
  readonly failedHandoverVersion?: string;
}

/** The answer each request takes. */
export interface RequestAnswers {
  readonly "install?": InstallAnswer;
  readonly "switch?": SwitchAnswer;
  readonly "versions?": VersionsAnswer;
}

/** Any answer to an environment request. */
export type LauncherAnswer = RequestAnswers[keyof RequestAnswers];

/** On the channel, a request and its answer carry the id the environment gave the request. */
export type Numbered<T> = T & { readonly id: number };

/** Everything the environment sends the launcher. */
export type EnvironmentMessage = PreparedMessage | Numbered<EnvironmentRequest> | LauncherReply;

/** Everything the launcher sends the environment. */
export type LauncherMessage = CommittedMessage | Numbered<LauncherAnswer> | LauncherQuery;

/** Whether `message` answers a request of `type`: the answer kinds it takes, a refusal only for a reason it can be refused for. */
export const answersRequest = (type: EnvironmentRequest["type"], message: LauncherMessage): boolean => {
  switch (type) {
    case "install?":
      return message.type === "installed" || (message.type === "refused" && isOneOf(INSTALL_REFUSALS, message.reason));
    case "switch?":
      return message.type === "switching" || (message.type === "refused" && isOneOf(SWITCH_REFUSALS, message.reason));
    case "versions?":
      return message.type === "versions";
  }
};

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isUpdateId = (value: unknown): value is string => typeof value === "string" && UPDATE_ID_PATTERN.test(value);
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.includes(value as T);
/** The keys of a record over a contracts enum, which a new member of that enum makes the compiler ask for here. */
const keysOf = <T extends string>(members: Record<T, true>): readonly T[] => Object.keys(members) as T[];

const READINESS = keysOf<EnvironmentReadiness>({ starting: true, ready: true, draining: true });
const BUSY_REASONS = keysOf<BusyReason>({ "run-starting": true, "run-running": true, "terminal-running": true, "parked-prompt": true, "recent-activity": true });
const DRAIN_TRIGGERS = keysOf<DrainTrigger>({ command: true, launcher: true, signal: true, update: true });
const REFUSALS: readonly (InstallRefusal | SwitchRefusal)[] = [...new Set([...INSTALL_REFUSALS, ...SWITCH_REFUSALS])];

const activityOf = (value: unknown): EnvironmentStatus["activity"] | undefined => {
  if (!isFields(value)) return undefined;
  if (value["state"] === "idle") return { state: "idle" };
  if (value["state"] === "draining") return isText(value["drainingSince"]) ? { state: "draining", drainingSince: value["drainingSince"] } : undefined;
  if (value["state"] !== "busy" || !isOneOf(BUSY_REASONS, value["reason"])) return undefined;
  const busyUntil = value["busyUntil"];
  if (busyUntil === undefined) return { state: "busy", reason: value["reason"] };
  return isText(busyUntil) ? { state: "busy", reason: value["reason"], busyUntil } : undefined;
};

/**
 * The launcher's message `value` is, as the environment reads it: a message
 * it does not know, or one missing what its kind needs, is undefined, and
 * fields no kind defines are dropped.
 */
export const parseLauncherMessage = (value: unknown): LauncherMessage | undefined => {
  if (!isFields(value)) return undefined;
  const { type, id } = value;
  switch (type) {
    case "committed":
    case "idle?":
    case "drain?":
      return { type };
    case "installed":
    case "switching":
      return isCount(id) ? { type, id } : undefined;
    case "refused": {
      const { reason } = value;
      if (!isCount(id) || !isOneOf(REFUSALS, reason)) return undefined;
      return { type, id, reason };
    }
    case "versions": {
      const { installed, launcherVersion, launcherProtocol, failedHandoverVersion } = value;
      if (!isCount(id) || !Array.isArray(installed) || !installed.every(isText)) return undefined;
      if (!isText(launcherVersion) || !isCount(launcherProtocol)) return undefined;
      if (failedHandoverVersion !== undefined && !isText(failedHandoverVersion)) return undefined;
      return { type, id, installed: [...installed], launcherVersion, launcherProtocol, ...(failedHandoverVersion === undefined ? {} : { failedHandoverVersion }) };
    }
    default:
      return undefined;
  }
};

/**
 * The environment's message `value` is, as the launcher reads it: a message
 * it does not know, or one missing what its kind needs, is undefined, and
 * fields no kind defines are dropped.
 */
export const parseEnvironmentMessage = (value: unknown): EnvironmentMessage | undefined => {
  if (!isFields(value)) return undefined;
  const { type, id, version } = value;
  switch (type) {
    case "prepared":
      return isText(version) ? { type, version } : undefined;
    case "install?":
      return isCount(id) && isText(version) && isText(value["staged"]) ? { type, id, version, staged: value["staged"] } : undefined;
    case "switch?":
      return isCount(id) && isText(version) && isUpdateId(value["updateId"]) ? { type, id, updateId: value["updateId"], version } : undefined;
    case "versions?":
      return isCount(id) ? { type, id } : undefined;
    case "idle": {
      const { readiness, updatesManagedOutside } = value;
      const activity = activityOf(value["activity"]);
      if (!isOneOf(READINESS, readiness) || activity === undefined || typeof updatesManagedOutside !== "boolean") return undefined;
      return { type, readiness, activity, updatesManagedOutside };
    }
    case "draining": {
      const { drainingSince, trigger } = value;
      return isText(drainingSince) && isOneOf(DRAIN_TRIGGERS, trigger) ? { type, drainingSince, trigger } : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Where a release's server artefact, unpacked, holds its own Node runtime:
 * where Node's archive for the platform puts it once unpacked into the
 * artefact's `node` folder. The launcher runs each installed version with it,
 * and the desktop runs the `service` verbs of the artefact it carries with it.
 */
export const artefactNode = (platform: string): readonly string[] => (platform === "win32" ? ["node", "node.exe"] : ["node", "bin", "node"]);

/** Where a release's server artefact, unpacked, holds its CLI's entry script. */
export const ARTEFACT_CLI_ENTRY: readonly string[] = ["packages", "cli", "dist", "main.js"];

/**
 * Where a release's server artefact, unpacked, declares what it is: its
 * CLI's `package.json`, whose `version` each release stamps and whose
 * `launcherProtocol` is the launcher protocol its environment needs.
 */
export const ARTEFACT_CLI_PACKAGE: readonly string[] = ["packages", "cli", "package.json"];

/**
 * What a version's `preflight` verb prints on its standard output once it
 * has loaded what it needs (SQLite, `node-pty`, the bundled Claude binary):
 * one JSON document, the version's identity under the release manifest's
 * names. The launcher runs a staged version's `preflight` before it installs
 * it and reads this; a later version only ever adds to it.
 */
export interface PreflightReport {
  readonly version: string;
  readonly protocolVersion: number;
  readonly launcherProtocol: number;
  /** The number of the version's last database migration. */
  readonly databaseSchemaVersion: number;
  /** What the bundled Claude binary's `--version` printed. */
  readonly bundledClaudeCodeVersion: string;
}

/**
 * The report a `preflight` printed as `text`, or undefined when it printed
 * anything but one report: a part missing or of the wrong kind, or more than
 * one document. Fields it does not define are dropped.
 */
export const parsePreflightReport = (text: string): PreflightReport | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isFields(value)) return undefined;
  const { version, protocolVersion, launcherProtocol, databaseSchemaVersion, bundledClaudeCodeVersion } = value;
  if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) return undefined;
  if (!isCount(protocolVersion) || !isCount(launcherProtocol) || !isText(bundledClaudeCodeVersion)) return undefined;
  if (!Number.isSafeInteger(databaseSchemaVersion) || (databaseSchemaVersion as number) < 0) return undefined;
  return { version, protocolVersion, launcherProtocol, databaseSchemaVersion: databaseSchemaVersion as number, bundledClaudeCodeVersion };
};

/**
 * The database, a file in the data directory: the environment's SQLite event
 * log, with its `-wal` and `-shm` files beside it. The launcher snapshots all
 * three before an update and copies them back when it rolls one back.
 */
export const DATABASE_FILE = "environment.db";

/**
 * The staging area, a directory in the data directory: where the environment
 * unpacks a version before `install?` names its folder. Of the files the
 * launcher owns there, the environment writes only this.
 */
export const STAGING_DIRECTORY = "staging";

/**
 * The outcome record, a file in the data directory: written by whoever rolled
 * an update back (the launcher after a failed trial or a crash loop, the
 * container's `update restore`), read by the environment as it settles that
 * update, and deleted by it once settled.
 */
export const OUTCOME_RECORD_FILE = "update-outcome.json";

/** The outcome record held while a database snapshot is being restored; nothing may open the database until it is cleared. */
export const RESTORE_MARKER_FILE = "restore-marker.json";

/** Where an update failed and was rolled back: its trial (the startup gate), or the crash-loop watch after its commit. */
export const OUTCOME_STAGES = ["trial", "crash-loop"] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

/** The outcome record's contents: which update was rolled back, from and to which versions, at which stage, and why. */
export interface OutcomeRecord {
  readonly updateId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly stage: OutcomeStage;
  /** A short code the writer names the failure with, such as `deadline` for a trial that missed its gate. */
  readonly reason: string;
}

/** Whether `value` is an outcome record: every part present, the update id one, the stage one a rollback has. */
export const isOutcomeRecord = (value: unknown): value is OutcomeRecord =>
  isFields(value) &&
  isUpdateId(value["updateId"]) &&
  isText(value["fromVersion"]) &&
  isText(value["toVersion"]) &&
  isOneOf(OUTCOME_STAGES, value["stage"]) &&
  isText(value["reason"]);
