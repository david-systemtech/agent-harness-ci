import type { BusyReason, DrainTrigger, EnvironmentStatus } from "@agent-harness/contracts";
import { clockTime } from "../transcript/format.js";

/**
 * What the Service row says (env spec, "Lifecycle"; ADR 0007;
 * docs/specs/gui.md, "Settings"; #417), as any renderer says it: the
 * environment's state as `environment.status` answers it, and what started
 * a drain.
 */

/** Why an environment is busy, in words. */
export const BUSY_WORDS: Readonly<Record<BusyReason, string>> = {
  "run-starting": "a run is starting",
  "run-running": "a run is running",
  "terminal-running": "a terminal runs a command",
  "parked-prompt": "a run is parked on a prompt",
  "recent-activity": "a run started or ended, or the environment started, within the idle window",
};

/** What started a drain, after "started by". */
export const DRAIN_TRIGGER_WORDS: Readonly<Record<DrainTrigger, string>> = {
  command: "a client",
  launcher: "its launcher",
  signal: "a signal to its process",
  update: "an update",
};

/** The environment's state in one line: `Ready and idle.`, `Ready and busy: a run is running.`, `Draining since 14:02: new runs are refused.` */
export const environmentStateWords = (status: EnvironmentStatus): string => {
  const { activity } = status;
  if (activity.state === "draining") return `Draining since ${clockTime(activity.drainingSince)}: new runs are refused.`;
  const readiness = status.readiness === "starting" ? "Starting" : "Ready";
  if (activity.state === "idle") return `${readiness} and idle.`;
  return `${readiness} and busy: ${BUSY_WORDS[activity.reason]}${activity.busyUntil === undefined ? "" : `, until ${clockTime(activity.busyUntil)} unless more happens`}.`;
};

/** What the state says of an environment whose updates are managed outside it (a container with no launcher, ADR 0007). */
export const UPDATES_MANAGED_OUTSIDE = "Its updates are managed outside it: a host-side updater recreates its container.";
