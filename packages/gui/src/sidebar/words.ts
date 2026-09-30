import type { ListFreshness, RowActivity } from "@agent-harness/client-runtime";

/**
 * What the sidebar says (docs/specs/gui.md, "The window and the sidebar"):
 * a row's activity, and how current an environment's list is. The rules
 * they word are the client runtime's (`activityOf`, the list's freshness),
 * which the terminal UI's rail draws too.
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
