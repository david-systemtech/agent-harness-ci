import { blockWords, credentialPromptWords, pendingUpdateWords, clockTime, type EnvironmentView } from "@agent-harness/client-runtime";

/**
 * What the window says of a connection (docs/specs/gui.md, "The local
 * environment, pairing and updates"): its phase in a word or two for its
 * sidebar heading, and in a sentence where the window waits on it, and a
 * block with the action it offers, in the terminal UI's sense.
 */

/** What the window calls the local environment before it has ever answered (#181), where it names it on its own. */
export const THIS_MACHINE = "This machine";

/** The runtime's placeholder for this machine's environment before it has answered (#181) has no name. */
export const nameOf = (view: EnvironmentView): string => view.name ?? "this machine";

/** The environment as a sentence begins with it. */
const subjectOf = (view: EnvironmentView): string => view.name ?? "The environment on this machine";

/** Since when an environment has not been reached, at this client's hour and minute. */
const unreachableWords = (since: string): string => `Unreachable since ${clockTime(since)}`;

/**
 * The phase in a word or two, under the environment's sidebar heading: since
 * when it has not been reached while it is on its way back (the runtime's
 * `unreachableSince`, on this client's clock, which measured it); none while
 * it is ready, or reached and catching its list up, which the list's
 * freshness says.
 */
export const phaseWords = (view: EnvironmentView, starting: boolean, installing: boolean, now: Date): string | undefined => {
  // While an update's start waits on macOS's prompt for its stored key (#1689), that is what it waits on.
  if (view.credentialPrompt !== undefined && view.phase !== "ready" && view.phase !== "syncing") return "Waiting on macOS: answer “Always Allow”";
  switch (view.phase) {
    case "ready":
    case "syncing":
      return undefined;
    case "service-down":
      return installing ? "Installing the environment (first start only)…" : starting ? "Starting…" : "Not running";
    case "starting":
      return "Starting…";
    case "connecting":
      return view.unreachableSince === null ? "Connecting…" : unreachableWords(view.unreachableSince);
    case "backoff":
      return view.unreachableSince === null ? "Cannot be reached" : unreachableWords(view.unreachableSince);
    // A service stopped by hand drains too; `updating` is the environment's own bye: updating, from any client (#1838).
    case "draining":
      return updateWords(view, now) ?? "Stopping…";
    case "updating":
      return updateWords(view, now) ?? "Restarting for an update…";
    case "disabled":
      return "Disabled";
    case "blocked":
      return blockWords(view);
  }
};

/** Progress across an older protocol, before the wire can report updates.status. */
export const updateWords = (view: EnvironmentView, now: Date): string | undefined => {
  const update = view.update;
  if (update === undefined) return undefined;
  if (update.restarting) return "Restarting for an update…";
  if (update.pending !== null) return pendingUpdateWords(update.pending, nameOf(view), now) ?? "Update requested; checking progress…";
  return update.error !== null
    ? `Update requested; progress could not be read: ${update.error}`
    : "Update requested; waiting for idle before restarting…";
};

/** The phase as a sentence, where the window waits on the environment. */
export const phaseSentence = (view: EnvironmentView, starting: boolean, installing: boolean, now: Date): string => {
  const subject = subjectOf(view);
  if (view.credentialPrompt !== undefined && view.phase !== "ready") return credentialPromptWords(view.credentialPrompt.toVersion);
  switch (view.phase) {
    case "ready":
      return `${subject} is ready.`;
    case "service-down":
      return installing ? "Installing the environment (first start only)…" : starting ? "Starting the environment on this machine…" : `${subject} is not running.`;
    case "starting":
      return `${subject} is starting…`;
    case "connecting":
    case "syncing":
      return `Connecting to ${nameOf(view)}…`;
    case "backoff":
      return `${subject} cannot be reached; this client tries again.`;
    case "draining":
      return updateWords(view, now) ?? `${subject} is stopping…`;
    case "updating":
      return updateWords(view, now) ?? `${subject} is restarting for an update…`;
    case "disabled":
      return `${subject} is disabled on this client.`;
    case "blocked":
      return blockWords(view);
  }
};

/**
 * What the connection offers that the window runs: starting the local
 * service, pairing again in place (a paired connection revoked or expired),
 * or trying again (a local one, whose grant is exchanged again). Updating
 * either side is said in its block's line.
 */
export type ConnectionRemedy = "start" | "re-pair" | "retry";

export const remedyOf = (view: EnvironmentView): ConnectionRemedy | undefined => {
  if (view.action === "service.start") return "start";
  if (view.phase !== "blocked" || (view.blocked !== "revoked" && view.blocked !== "expired" && view.blocked !== "credential-unavailable")) return undefined;
  return view.kind === "paired" ? "re-pair" : "retry";
};
