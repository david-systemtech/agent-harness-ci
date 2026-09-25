import { LOCAL_PLACEHOLDER_ID, type ClientPreferences, type EnvironmentView, type LocalStatus, type Notice } from "@agent-harness/client-runtime";

/**
 * What the screen shows, derived from the runtime's projections with no
 * state of its own: the phase words, the environment the header is about,
 * whether the service-down offer stands, a notice's line.
 */

/**
 * An environment's name as the screen says it: the runtime's placeholder
 * for a local environment that has not answered yet has none, and is "this
 * machine" (docs/specs/client-runtime.md, the #181 notes).
 */
export const nameOf = (view: EnvironmentView): string => view.name ?? "this machine";

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
  views.find((v) => v.environmentId === wanted) ?? views.find((v) => v.name?.toLowerCase() === wanted.trim().toLowerCase());

/** The runtime's stand-in for a local environment that has not answered yet (#181): listed, but no environment to use. */
export const isPlaceholder = (view: EnvironmentView): boolean => view.environmentId === LOCAL_PLACEHOLDER_ID;

/** The environments there are to use: every listed one but the placeholder. */
export const knownEnvironments = (views: readonly EnvironmentView[]): readonly EnvironmentView[] => views.filter((v) => !isPlaceholder(v));

/**
 * The environment the header is about (ADR 0005's default-environment
 * rule): the one `--environment` names, else the last used, else the local
 * one, else the primary, the first of the others `projections.environments`
 * lists; the placeholder only when there is nothing else.
 */
export const currentEnvironment = (
  views: readonly EnvironmentView[],
  preferences: ClientPreferences,
  wanted: string | undefined,
): EnvironmentView | undefined => {
  const known = knownEnvironments(views);
  return (
    (wanted === undefined ? undefined : findEnvironment(known, wanted)) ??
    known.find((v) => v.environmentId === preferences["environments.lastUsed"]) ??
    localEnvironment(known) ??
    known[0] ??
    views[0]
  );
};

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

/** A fault the runtime could hand no caller (`platform.reportError`), and when it was reported. */
export interface Fault {
  readonly message: string;
  /** ISO time, as a notice's `at`. */
  readonly at: string;
}

/**
 * The activity line: the newer of the latest fault and the latest notice
 * (a notice on a tie), so neither hides what follows it; undefined when
 * there is neither. The notices it does not show are counted after it,
 * with where they are stacked (`/notices`, #149).
 */
export const activityLine = (faults: readonly Fault[], notices: readonly Notice[]): string | undefined => {
  const fault = faults.at(-1);
  const notice = notices.at(-1);
  const faultFirst = fault !== undefined && (!notice || Date.parse(fault.at) > Date.parse(notice.at));
  const shown = faultFirst ? fault.message : notice ? noticeLine(notice) : undefined;
  const more = notices.length - (faultFirst ? 0 : 1);
  return shown === undefined || more <= 0 ? shown : `${shown} (+${more} more: /notices)`;
};

/** What went wrong, in the words of the error. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
