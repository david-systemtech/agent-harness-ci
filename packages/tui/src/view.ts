import type { ClientPreferences, EnvironmentView, LocalStatus, Notice } from "@agent-harness/client-runtime";

/**
 * What the screen shows, derived from the runtime's projections with no
 * state of its own: the phase words, the environment the header is about,
 * whether the service-down offer stands, a notice's line.
 */

/** A connection phase in the words the rail and `/environment` use. */
export const phaseWords = (view: EnvironmentView): string => {
  switch (view.phase) {
    case "service-down":
      return "service down";
    case "backoff":
      return "reconnecting";
    case "blocked":
      return `blocked: ${view.blocked ?? "unknown"}`;
    default:
      return view.phase;
  }
};

/** Hours and minutes in this machine's time zone, for "unreachable since". */
export const clockTime = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** A heading's state: the phase, or since when it has not been reached; nothing while it is ready. */
export const headingState = (view: EnvironmentView, startingService: boolean): string | undefined => {
  if (view.kind === "local" && startingService && view.phase === "service-down") return "starting";
  if (view.phase === "ready") return undefined;
  if (view.phase === "blocked") return phaseWords(view);
  if (view.unreachableSince !== null && view.phase !== "disabled" && view.phase !== "starting") {
    return `${view.phase === "service-down" ? "service down" : "unreachable"} since ${clockTime(view.unreachableSince)}`;
  }
  return phaseWords(view);
};

/** Matches `--environment`: an id exactly, or a name ignoring case. */
export const findEnvironment = (views: readonly EnvironmentView[], wanted: string): EnvironmentView | undefined =>
  views.find((v) => v.environmentId === wanted) ?? views.find((v) => v.name.toLowerCase() === wanted.trim().toLowerCase());

/**
 * The environment the header is about (ADR 0005's default-environment
 * rule): the one `--environment` names, else the last used, else the local
 * one, else the primary.
 */
export const currentEnvironment = (
  views: readonly EnvironmentView[],
  preferences: ClientPreferences,
  wanted: string | undefined,
): EnvironmentView | undefined =>
  (wanted === undefined ? undefined : findEnvironment(views, wanted)) ??
  views.find((v) => v.environmentId === preferences["environments.lastUsed"]) ??
  views.find((v) => v.kind === "local") ??
  views[0];

/** The local environment, when the runtime lists it. */
export const localEnvironment = (views: readonly EnvironmentView[]): EnvironmentView | undefined => views.find((v) => v.kind === "local");

/**
 * Whether the local environment is down: listed with phase `service-down`,
 * or not listed at all because the grant could not be exchanged on a first
 * start with its service down.
 */
export const localIsDown = (views: readonly EnvironmentView[], local: LocalStatus): boolean => {
  const listed = localEnvironment(views);
  if (listed) return listed.phase === "service-down" && listed.enabled;
  return local.state === "failed" && local.reason === "service-down";
};

export const SERVICE_DOWN = "The environment on this machine is not running.";

/** The one line above the composer that offers to start it: "install and start it" when no service is installed. */
export const offerLine = (installed: boolean): string =>
  installed ? `${SERVICE_DOWN} Start it? y/n` : `${SERVICE_DOWN} Install and start it? y/n`;

/** What David can do about a notice, in words, beside its message. */
const actionHint = (notice: Notice): string | undefined => {
  switch (notice.action) {
    case "re-pair":
      return "(/pair <link>, or /pair <address> <code>)";
    case "update-environment":
      return "Its self-update is the way to do it.";
    default:
      return undefined;
  }
};

/** A notice as the activity line shows it: its message, then its action. */
export const noticeLine = (notice: Notice): string => [notice.message, actionHint(notice)].filter(Boolean).join(" ");
