import type { EnvironmentView } from "@agent-harness/client-runtime";

/**
 * What the window says of a connection (docs/specs/gui.md, "The local
 * environment, pairing and updates"): its phase in a word or two for its
 * sidebar heading, and in a sentence where the window waits on it, and a
 * block with the action it offers, in the terminal UI's sense.
 */

/** The runtime's placeholder for this machine's environment before it has answered (#181) has no name. */
export const nameOf = (view: EnvironmentView): string => view.name ?? "this machine";

/** The environment as a sentence begins with it. */
const subjectOf = (view: EnvironmentView): string => view.name ?? "The environment on this machine";

/** A block, with what to do about it, in one line. */
export const blockLine = (view: EnvironmentView): string => {
  const name = nameOf(view);
  const again = view.kind === "local" ? "try again" : "pair it again";
  switch (view.blocked) {
    case "unsupported-client":
      return `${subjectOf(view)} is newer than this client: update this client.`;
    case "protocol-mismatch":
      return view.action === "update-environment"
        ? `${subjectOf(view)} is older than this client: update ${name} to this client's version.`
        : `${subjectOf(view)} is older than this client, and cannot update itself from here.`;
    case "revoked":
      return `This client's access to ${name} was revoked: ${again}.`;
    case "expired":
      return `This client's access to ${name} expired: ${again}.`;
    case "different-environment":
      return `The address kept for ${name} now reaches another environment.`;
    default:
      return `${subjectOf(view)} is blocked.`;
  }
};

/** The phase in a word or two, under the environment's sidebar heading; none while it is ready. */
export const phaseWords = (view: EnvironmentView, starting: boolean): string | undefined => {
  switch (view.phase) {
    case "ready":
      return undefined;
    case "service-down":
      return starting ? "Starting…" : "Not running";
    case "starting":
      return "Starting…";
    case "connecting":
    case "syncing":
      return "Connecting…";
    case "backoff":
      return "Cannot be reached";
    case "draining":
    case "updating":
      return "Restarting for an update…";
    case "disabled":
      return "Disabled";
    case "blocked":
      return blockLine(view);
  }
};

/** The phase as a sentence, where the window waits on the environment. */
export const phaseSentence = (view: EnvironmentView, starting: boolean): string => {
  const subject = subjectOf(view);
  switch (view.phase) {
    case "ready":
      return `${subject} is ready.`;
    case "service-down":
      return starting ? "Starting the environment on this machine…" : `${subject} is not running.`;
    case "starting":
      return `${subject} is starting…`;
    case "connecting":
    case "syncing":
      return `Connecting to ${nameOf(view)}…`;
    case "backoff":
      return `${subject} cannot be reached; this client tries again.`;
    case "draining":
    case "updating":
      return `${subject} is restarting for an update…`;
    case "disabled":
      return `${subject} is disabled on this client.`;
    case "blocked":
      return blockLine(view);
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
  if (view.phase !== "blocked" || (view.blocked !== "revoked" && view.blocked !== "expired")) return undefined;
  return view.kind === "paired" ? "re-pair" : "retry";
};
