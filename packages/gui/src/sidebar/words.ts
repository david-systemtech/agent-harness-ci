import { noManualOrder, type ListFreshness, type Refusal, type RowActivity } from "@agent-harness/client-runtime";
import type { CommandMethodName } from "@agent-harness/contracts";

/**
 * What the sidebar says (docs/specs/gui.md, "The window and the sidebar"):
 * a row's activity, how current an environment's list is, what an
 * organising command did not do and why a drop is refused. The rules they
 * word are the client runtime's (`activityOf`, the list's freshness, a
 * drop's plan), which the terminal UI's rail draws too.
 */

/** A row's activity as its mark is named: none while idle; a parked session with its count of prompts waiting. */
export const activityWords = (activity: RowActivity): string | undefined => {
  switch (activity.state) {
    case "idle":
      return undefined;
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "parked":
      return activity.parked === 0 ? "Waiting for you" : `${activity.parked} ${activity.parked === 1 ? "prompt" : "prompts"} waiting for you`;
  }
};

/** An environment's list until it is live: catching up, or what this window last saw; nothing once live or before anything was asked. */
export const freshnessWords = (list: ListFreshness | undefined): string | undefined => {
  switch (list?.freshness) {
    case "catching-up":
      return "Catching up…";
    case "cached":
      return "Cached: what this window last saw.";
    default:
      return undefined;
  }
};

/** A session's title as a line quotes it. */
export const quoted = (title: string): string => `“${title}”`;

/** What a line says an organising command did not do, before why: "Not pinned", "Not taken out of the archive". */
export const notDone = (method: CommandMethodName): string => {
  switch (method) {
    case "sessions.rename":
      return "Not renamed";
    case "sessions.pin":
      return "Not pinned";
    case "sessions.unpin":
      return "Not unpinned";
    case "sessions.archive":
      return "Not archived";
    case "sessions.unarchive":
      return "Not taken out of the archive";
    case "sessions.settle":
      return "Not settled";
    case "sessions.unsettle":
      return "Not unsettled";
    case "sessions.snooze":
      return "Not snoozed";
    case "sessions.unsnooze":
      return "Not woken";
    case "sessions.tag":
      return "Not tagged";
    case "sessions.untag":
      return "The tag was not taken off";
    case "sessions.delete":
      return "Not deleted";
    case "sessions.restore":
      return "Not restored";
    case "groups.rename":
      return "The group was not renamed";
    case "groups.delete":
      return "The group was not deleted";
    default:
      return "Not moved";
  }
};

/** Why a drop sends nothing, in the sidebar's words; `title` the dragged session's, `environment` the name of the one it is on. */
export const refusalWords = (refusal: Refusal, title: string, environment: string): string => {
  switch (refusal.why) {
    case "shelf":
      return `Not moved: ${noManualOrder(refusal.shelf)}.`;
    case "environment":
      return `Not moved: ${quoted(title)} is on ${environment}, and a session stays on its own environment.`;
    case "repository":
      return "Not moved: a repository is not a group; a session's repository is its workspace's.";
    case "filtered":
      return "Not moved: the filter may hide the sessions a move goes between; clear it first.";
  }
};
