import type { UpdateFailedPayload } from "@agent-harness/contracts";
import type { Notice, Notices } from "../notices.js";
import { credentialUpdateFailedWords } from "./words.js";

/**
 * The one notice of an update rolled back for want of the stored key
 * (#1689). Two sides can say it of the same trial: the environment, in its
 * `update-failed` (reason `credential`; or `deadline` under a launcher older
 * than the wait, which ends an unanswered wait as any other), and the
 * desktop, from the record the ended start left. Each side's report waits
 * here, per environment, for the other's of the same trial, which uses it up:
 * the desktop's for the next `update-failed` that occurred within
 * `PAIRING_MS` of it, the
 * environment's `deadline` for a desktop report of a wait first seen before
 * it. A notice of another trial, or one left on the queue, keeps its words.
 */

/** How long after the desktop's report the environment's of the same trial may come: a rollback, a restart and a reconnect. A chosen default. */
export const PAIRING_MS = 10 * 60_000;

interface Reports {
  /** The desktop's notice that the prompt went unanswered, until the environment's report of that trial. */
  desktop?: { readonly toVersion: string; readonly notice: Notice } | undefined;
  /** The environment's notice of a trial that missed its deadline, until the desktop's report of a wait seen before it. */
  environment?: { readonly toVersion: string; readonly fromVersion: string; readonly notice: Notice } | undefined;
}

const reportsOf = new WeakMap<Notices, Map<string, Reports>>();

const reports = (notices: Notices, environmentId: string): Reports => {
  let byEnvironment = reportsOf.get(notices);
  if (byEnvironment === undefined) reportsOf.set(notices, (byEnvironment = new Map()));
  let held = byEnvironment.get(environmentId);
  if (held === undefined) byEnvironment.set(environmentId, (held = {}));
  return held;
};

const credentialFailure = (notices: Notices, environmentId: string, name: string | null, toVersion: string, fromVersion?: string): Notice =>
  notices.raise(environmentId, { kind: "update-failed", message: credentialUpdateFailedWords(name, toVersion, fromVersion), action: null });

/**
 * The desktop saw the start of `toVersion` wait on the prompt, from
 * `seenAt`, and end with it unanswered: the environment's `deadline` of that
 * trial, already shown, is reworded; else the desktop says it, and the
 * environment's coming report of the trial uses it up.
 */
export const desktopSawUnanswered = (notices: Notices, environmentId: string, name: string | null, toVersion: string, seenAt: Date): void => {
  const held = reports(notices, environmentId);
  const environment = held.environment;
  held.environment = undefined;
  if (environment?.toVersion === toVersion && Date.parse(environment.notice.at) >= seenAt.getTime() && notices.retire((notice) => notice.id === environment.notice.id).length > 0) {
    credentialFailure(notices, environmentId, name, toVersion, environment.fromVersion);
    return;
  }
  held.desktop = { toVersion, notice: credentialFailure(notices, environmentId, name, toVersion) };
};

/**
 * The environment's `update-failed`, which occurred `at`: in the stored key's
 * words where its trial failed for it, which the desktop's report of that
 * trial may tell.
 */
export const environmentUpdateFailed = (notices: Notices, environmentId: string, name: string, payload: UpdateFailedPayload, at: Date): void => {
  const { fromVersion, toVersion, stage, reason } = payload;
  const held = reports(notices, environmentId);
  const desktop = held.desktop;
  held.desktop = undefined;
  const paired = desktop?.toVersion === toVersion && Math.abs(at.getTime() - Date.parse(desktop.notice.at)) <= PAIRING_MS;
  if (reason === "credential" || (paired && stage === "trial" && reason === "deadline")) {
    if (paired) notices.retire((notice) => notice.id === desktop.notice.id);
    credentialFailure(notices, environmentId, name, toVersion, fromVersion);
    return;
  }
  const notice = notices.raise(environmentId, { kind: "update-failed", message: `${name} could not be updated to ${toVersion} (${stage}: ${reason}). It is running ${fromVersion}.`, action: null });
  if (stage === "trial" && reason === "deadline") held.environment = { toVersion, fromVersion, notice };
};
