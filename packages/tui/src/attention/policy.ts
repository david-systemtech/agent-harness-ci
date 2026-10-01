import { formatDuration, formatUsd, type RunState } from "@agent-harness/client-runtime";

/**
 * The line that greets somebody who has been away from the keyboard
 * (docs/specs/tui.md, "Attention"): the sessions whose prompt parked or whose
 * run ended meanwhile. Pure: none of it touches the clock, the runtime or a
 * stream. What the title and a notification say are the client runtime's
 * (`titleStateOf`, `notificationFor`), which the desktop window says too;
 * the away summary says a session "is waiting on you" whatever its prompt's
 * kind (a chosen default, since a prompt can be more than a permission
 * request).
 */

/** The run states the away summary calls work in flight: from the key that started it until its run ends. */
const WORKING: ReadonlySet<RunState> = new Set<RunState>(["starting", "running", "parked"]);

/** A name, or nothing if it is blank. */
const oneWord = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? undefined : trimmed;
};

/** A turn that ended, in the parts worth reporting afterwards. */
export interface RunEnded {
  /** This terminal's clock when it heard the run end, in milliseconds. */
  readonly at: number;
  readonly durationMs?: number | undefined;
  readonly costUsd?: number | undefined;
  /** It ended in an error rather than in an answer. */
  readonly failed?: boolean | undefined;
}

/** One session, as the away summary reads it. */
export interface RecapSubject {
  readonly title?: string | undefined;
  readonly status: RunState;
  readonly pendingPrompts: number;
  /** Its last finished turn, whenever that was. */
  readonly lastRun?: RunEnded | undefined;
  /** This terminal's clock when it heard a prompt park on it; stale once answered. */
  readonly askedAt?: number | undefined;
}

/** How many things the line names before it counts the rest. */
export const RECAP_CLAUSES = 2;

/** How long a keyboard must have been still for the next key to be a return. */
export const AWAY_MS = 3 * 60_000;

/** How long the away summary stays on the line. */
export const RECAP_FLASH_MS = 8_000;

const UNNAMED = "a session";

/** One session's news since `since`, or nothing: a waiting prompt outranks a finished turn. */
const recapClause = (subject: RecapSubject, since: number): string | undefined => {
  const name = oneWord(subject.title) ?? UNNAMED;
  if (subject.pendingPrompts > 0) return subject.askedAt !== undefined && subject.askedAt > since ? `${name} is waiting on you` : undefined;
  const run = subject.lastRun;
  // Still working: what it finished before this turn is not the news.
  if (run === undefined || run.at <= since || WORKING.has(subject.status)) return undefined;
  if (run.failed === true) return `${name} stopped with an error`;
  const spent = [run.durationMs === undefined ? undefined : formatDuration(run.durationMs), run.costUsd === undefined ? undefined : formatUsd(run.costUsd)].filter(
    (part): part is string => part !== undefined,
  );
  return spent.length === 0 ? `${name} finished` : `${name} finished (${spent.join(", ")})`;
};

/**
 * What changed while the keyboard was untouched (`since` is the last
 * keypress): names first, two clauses then a count, in the order given (the
 * rail's), and nothing at all when nothing changed.
 */
export const awayRecap = (subjects: readonly RecapSubject[], since: number): string | undefined => {
  const clauses = subjects.map((subject) => recapClause(subject, since)).filter((clause): clause is string => clause !== undefined);
  if (clauses.length === 0) return undefined;
  const named = clauses.slice(0, RECAP_CLAUSES);
  const rest = clauses.length - named.length;
  return `while you were away: ${named.join(" · ")}${rest > 0 ? ` · +${rest} more` : ""}`;
};
