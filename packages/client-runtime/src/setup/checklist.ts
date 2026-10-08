import { FIRST_ROW, REGISTERED_STEP_IDS, agoWords, pastTimeWords, settingsRow, type LastGood, type RegisteredStepId, type SettingsRowId, type StepId, type StepResult, type StepState } from "@agent-harness/contracts";
import type { SetupCounts, SetupReach, SetupStepView, SetupView } from "../projections/setup.js";
import { clockTime, whenWords } from "../transcript/format.js";

/**
 * Set up's checklist as every renderer draws it from `projections.setup`
 * (the Set up specification, "The checklist in the GUI" and "The terminal
 * UI"; ADR 0031; #413): a state in words, the health a row of Settings
 * shows, a step's line, and the counts, so the window and the terminal say
 * the same of one environment (ADR 0004).
 */

/** Whether this build registers `step`, so `setup.check` can ask about it alone. */
export const isRegisteredStep = (step: StepId): step is RegisteredStepId => (REGISTERED_STEP_IDS as readonly StepId[]).includes(step);

/**
 * The steps a row of Settings is home to that this build can ask about
 * alone, which its pane checks as it opens (ADR 0031: a client calls
 * `setup.check` when a step's pane opens); none on Set up's own row, which
 * checks every step, or on a row no step lives on.
 */
export const homedChecks = (row: SettingsRowId): readonly RegisteredStepId[] => {
  const { homeOf } = settingsRow(row);
  return typeof homeOf === "string" ? [] : homeOf.filter(isRegisteredStep);
};

/** Each state in words, as a dot is named and a line says it (setup-copy.md §3, "State words"). */
export const STEP_STATE_WORDS: { readonly [State in StepState]: string } = { done: "Done", "needs-attention": "Needs a fix", skipped: "Not set up", pending: "Checking" };

/**
 * How bad each state is, the worst last: a step that needs attention is
 * worse than one pending a scheduled read, which is neutral but not yet
 * known to pass. Done is worse than skipped, which checked
 * nothing, so a row whose checked steps all pass shows done even beside a
 * step with nothing set up (a chosen default: ADR 0031 names the worst state
 * but not the order of the two that pass).
 */
const SEVERITY: { readonly [State in StepState]: number } = { skipped: 0, done: 1, pending: 2, "needs-attention": 3 };

/** The worst of `states`; null for none. */
export const worstState = (states: readonly StepState[]): StepState | null =>
  states.reduce<StepState | null>((worst, state) => (worst === null || SEVERITY[state] > SEVERITY[worst] ? state : worst), null);

/**
 * The health dot of a row of Settings on the environment `view` checks
 * (ADR 0027; docs/specs/gui.md, "Health dots"): on a step's home row, the
 * worst state of the steps homed there; on Set up's row, the worst of every
 * step; null on a row no step lives on, or while no step it shows has a
 * result, a step the environment does not register showing none.
 */
export const rowHealth = (view: SetupView, row: SettingsRowId): StepState | null =>
  worstState(view.steps.flatMap((step) => ((row === FIRST_ROW || step.home === row) && step.result !== null ? [step.result.state] : [])));

/**
 * A result's reason with each past time it names worded as this client
 * words one, "2 h ago, at 16:24" where it is, in place of the environment's
 * words for it (#1742); as it is when it names none.
 */
const reasonWords = ({ reason, times }: StepResult, now: Date): string =>
  (times ?? []).reduce((words, { text, at }) => words.replace(text, () => pastTimeWords(at, now)), reason);

/**
 * A step's line (setup-copy.md §3): "Checking…" while this client's own
 * check of it is pending (ADR 0031's half second), else its result's reason,
 * the times it names worded where this client is; "Not checked yet. Choose
 * Check again." with no result. When it was checked is `stepNote`'s, beneath.
 * `now` is the environment's time as this client reckons it, which says
 * whether a time was today.
 */
export const stepLine = (step: SetupStepView, now: Date): string => {
  if (step.pending) return "Checking…";
  if (step.result === null) return "Not checked yet. Choose Check again.";
  return reasonWords(step.result, now);
};

/**
 * The muted second line beneath a step's line (setup-copy.md §3), or none.
 * A result not known to hold now says it may be out of date, naming the
 * environment `name` that cannot be reached (the Set up specification,
 * "Running checks": an unreachable environment's cached results, #573). A
 * result this client follows says since when nothing changed, "No change
 * since 09:14.", for a re-check that finds nothing new is never heard
 * (#671); one it asked for says its age once older than its step's cadence,
 * "Last checked 3 h ago.". None while it is checked, never was, or is fresh.
 */
export const stepNote = (step: SetupStepView, now: Date, name: string): string | undefined => {
  const { result } = step;
  if (step.pending || result === null) return undefined;
  if (result.stale) return `This may be out of date: ${name} cannot be reached.`;
  if (!result.asked) return `No change since ${whenWords(result.checkedAt, now)}.`;
  return result.olderThanCadence ? `Last checked ${agoWords(result.ageMs)}.` : undefined;
};

/** "needs" for one step, "need" for any other count: `1 needs a fix`, `2 need a fix`. */
export const needsWord = (count: number): string => (count === 1 ? "needs" : "need");

/**
 * The counts, as the Set up pane says them (setup-copy.md §4.5):
 * `8 done · 1 needs a fix · 2 not set up`, over the steps the environment
 * registers; a step it does not register is counted nowhere, its name drawn
 * dim instead. The remainder of registered results are pending scheduled
 * reads and counted as checking only while present.
 */
export const countsWords = (counts: SetupCounts): string => {
  const pending = counts.registered - counts.done - counts.needsAttention - counts.skipped;
  return `${counts.done} done · ${counts.needsAttention} ${needsWord(counts.needsAttention)} a fix · ${counts.skipped} not set up${pending > 0 ? ` · ${pending} checking` : ""}`;
};

/**
 * The result that passed before one that could not check, beneath it,
 * dated (ADR 0031; setup-copy.md §3): `Last time it worked (2 h ago): <its
 * line>`, its age counted against `now`, the environment's time as this
 * client reckons it.
 */
export const lastGoodWords = (lastGood: LastGood, now: Date): string =>
  `Last time it worked (${agoWords(Math.max(0, now.getTime() - Date.parse(lastGood.checkedAt)))}): ${lastGood.reason}`;

/**
 * Why the results are not known to hold now (the Set up specification,
 * "Running checks": unreachable is the client's to see; setup-copy.md §3),
 * naming the environment; undefined while it can be reached.
 */
export const setupReachWords = (reach: SetupReach, name: string): string | undefined => {
  switch (reach.status) {
    case "reachable":
      return undefined;
    case "service-down":
      return `agent-harness is not running on ${name}. These results are from before it stopped.`;
    case "unreachable":
      return reach.since === null ? `This app has not reached ${name} yet.` : `This app cannot reach ${name} (since ${clockTime(reach.since)}). These results may be out of date.`;
  }
};
