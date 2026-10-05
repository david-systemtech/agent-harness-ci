import { DRAIN_CAP_MS, type PendingUpdate } from "@agent-harness/contracts";
import type { UpdateEnvironmentOutcome } from "../connections/environment-update.js";
import { newerVersion, type BundledServerView, type DesktopBuildView } from "../desktop-update.js";
import { BUSY_WORDS } from "../service/words.js";
import { whenWords } from "../transcript/format.js";

/**
 * What the update controls say, as any renderer says it (launcher-update
 * spec, "Settings, methods, notices and flags" and "The desktop moves with
 * its local environment"; ADR 0025, ADR 0026; #424): an environment's
 * pending update and what it waits on, the Claude Code it bundles, a pin,
 * the desktop's own build, the server the desktop carries, and the offer
 * of a client newer than the environment, and what Drain and update now
 * asks (#825). The window draws an environment's on About and Your
 * machines' cards, the terminal UI on its card in `/environment` (#827).
 */

/** The version an environment runs, which heads its update controls (`updates.status`'s, else the descriptor's). */
export const environmentVersionWords = (version: string): string => `Version ${version}`;

/** Why an environment's updates could not be read: `updates.status` failed, with its message. */
export const updatesUnreadWords = (message: string): string => `Its updates could not be read: ${message}`;

/**
 * A pending update in one line, with what it waits on and when busy work
 * stops holding it (on this client's calendar, as it is `now`); null when
 * nothing is pending.
 */
export const pendingUpdateWords = (pending: PendingUpdate, environment: string, now: Date): string | null => {
  switch (pending.state) {
    case "current":
      return null;
    case "staging":
      return `Staging ${pending.toVersion}: downloading and installing it.`;
    case "waiting": {
      const { waitsOn } = pending;
      if (waitsOn === null) return `Updating to ${pending.toVersion} within a minute: nothing holds it.`;
      const until = waitsOn.until === null ? "" : `, until ${whenWords(waitsOn.until, now)} unless more happens`;
      return `Waiting to update to ${pending.toVersion} until ${environment} is idle: ${BUSY_WORDS[waitsOn.reason]}${until}. Forced at ${whenWords(pending.deferUntil, now)}.`;
    }
    case "ready":
      return `${pending.toVersion} is ready: it waits for the host-side updater.`;
    case "draining":
      return `Draining for the update to ${pending.toVersion}: new runs are refused.`;
    case "switching":
      return `Switching to ${pending.toVersion}.`;
    case "blocked":
      return `The update to ${pending.toVersion} is blocked: ${pending.message}`;
  }
};

/** A pending update that waits for idle, the deferral cap or a request. */
export type WaitingUpdate = Extract<PendingUpdate, { readonly state: "waiting" }>;

/**
 * The update Drain and update now takes (launcher-update spec, story 11;
 * #825): the pending update while busy work holds it, which `updates.apply`
 * with `when: now` drains at once, cutting running runs at the drain's cap;
 * null when none waits, or nothing holds it and it drains at the next tick.
 */
export const drainableUpdate = (pending: PendingUpdate): WaitingUpdate | null => (pending.state === "waiting" && pending.waitsOn !== null ? pending : null);

/** What Drain and update now asks before it drains `environment` for the update to `toVersion`. */
export const drainAndUpdateQuestion = (environment: string, toVersion: string): string => `Drain ${environment} and update it to ${toVersion} now?`;

/** What Drain and update now does, said as it is asked: new runs refused at once, running ones cut at the drain's cap. */
export const drainAndUpdateDescription = (environment: string, toVersion: string): string =>
  `${environment} refuses new runs at once and lets the running ones finish for up to ${DRAIN_CAP_MS / 60_000} minutes, then cuts any still running and restarts on ${toVersion}. A run it cuts carries on after the update when its provider can resume it.`;

/** The Claude Code an environment's version bundles, which moves with it (`updates.status`'s `bundledClaudeCodeVersion`). */
export const bundledClaudeCodeWords = (version: string | null): string =>
  version === null ? "Claude Code (bundled), its version not read, updates with this environment." : `Claude Code (bundled) ${version}, updates with this environment.`;

/** A pinned version, which holds the environment still: auto-update is off while it is set. */
export const pinnedWords = (version: string): string => `Pinned to ${version}: auto-update is off until it is unpinned.`;

/** The desktop's own build, where its update is, in one line; null before it is checked. */
export const desktopBuildWords = (build: DesktopBuildView): string | null => {
  switch (build.state) {
    case "unchecked":
      return null;
    case "checking":
      return "Checking for a newer build…";
    case "current":
      return "This client's build is the newest.";
    case "unsupported":
      return "This install cannot update itself: download a newer build from the release page.";
    case "staging":
      return `Staging ${build.toVersion} through this machine's environment…`;
    case "ready":
      return `${build.staged.version} is ready: it installs when this client next quits, or now with Restart to update.`;
    case "applying":
      return `Restarting to update to ${build.staged.version}…`;
    case "failed":
      return build.message;
  }
};

/** The server artefact the desktop carries, against the local environment `environment`, in one line; null when there is nothing to say of it. */
export const bundledServerWords = (bundled: BundledServerView, environment: string): string | null => {
  switch (bundled.state) {
    case "unchecked":
    case "none":
      return null;
    case "offered":
      return `This desktop carries the server ${bundled.version}, newer than ${environment}'s ${bundled.environmentVersion}.`;
    case "handing-over":
      return `Handing the bundled ${bundled.version} to ${environment}…`;
    case "handed-over":
      return `${environment} took the bundled ${bundled.version}: it updates once it is idle.`;
    case "failed":
      return bundled.version === null ? bundled.message : `Could not install the bundled ${bundled.version} for ${environment}: ${bundled.message}`;
  }
};

/** The states in which an update is under way to a version. */
const UNDER_WAY: ReadonlySet<PendingUpdate["state"]> = new Set(["staging", "waiting", "ready", "draining", "switching"]);

/**
 * Whether this client, at `client`, offers to update the environment
 * running `environment` to its version (launcher-update spec, "a newer
 * client offers to update the environment to its version"): it is newer,
 * and no update under way there goes as far already.
 */
export const offersClientVersion = (client: string, environment: string, pending: PendingUpdate | null): boolean => {
  if (!newerVersion(client, environment)) return false;
  const going = pending !== null && UNDER_WAY.has(pending.state) && "toVersion" in pending ? pending.toVersion : null;
  return going === null || newerVersion(client, going);
};

/** The offer of a newer client, in one line. */
export const clientOfferWords = (client: string, environment: string, environmentVersion: string): string =>
  `This client runs ${client}, newer than ${environment}'s ${environmentVersion}.`;

/** What the offer of a newer client asks, as the control that sends it says it. */
export const clientOfferAskWords = (client: string, environment: string): string => `Update ${environment} to ${client}`;

/** What asking the environment to update to this client's version came to, in one line. */
export const clientUpdateWords = (outcome: UpdateEnvironmentOutcome, environment: string): string =>
  outcome.ok ? `Updating ${environment} to ${outcome.toVersion} once it is idle.` : `Not updated: ${outcome.message}`;
