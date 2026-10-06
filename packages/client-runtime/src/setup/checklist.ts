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

/** Each state in words, as a dot is named and a line says it. */
export const STEP_STATE_WORDS: { readonly [State in StepState]: string } = { done: "done", "needs-attention": "needs attention", skipped: "skipped", pending: "checking" };

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
 * How long ago a check ran: `checked just now` under a minute, then whole
 * minutes under an hour (`checked 5 min ago`), whole hours under two days
 * (`checked 30 h ago`, which a day would round to half its size), else whole
 * days (`checked 2 d ago`).
 */
export const checkedAgoWords = (ageMs: number): string => `checked ${agoWords(ageMs)}`;

/**
 * A result's reason with each past time it names worded as this client
 * words one, "2 h ago, at 16:24" where it is, in place of the environment's
 * words for it (#1742); as it is when it names none.
 */
const reasonWords = ({ reason, times }: StepResult, now: Date): string =>
  (times ?? []).reduce((words, { text, at }) => words.replace(text, () => pastTimeWords(at, now)), reason);

/**
 * A step's line: "Checking…" while this client's own check of it is pending
 * (ADR 0031's half second), else its result's reason, the times it names
 * worded where this client is, dated. A result this
 * client follows says since when it is unchanged, "(unchanged since 09:14)",
 * for a re-check that finds nothing new is never heard (#671); one it asked
 * for says its age once older than its step's cadence, "(checked 3 h ago)".
 * Either is marked stale while it is not known to hold now (the Set up
 * specification, "Running checks": an unreachable environment's cached
 * results beneath its line, #573), "(stale, checked 10 min ago)". "Not
 * checked yet." with no result. `now` is the environment's time as this
 * client reckons it, which says whether a time was today.
 */
export const stepLine = (step: SetupStepView, now: Date): string => {
  if (step.pending) return "Checking…";
  const { result } = step;
  if (result === null) return "Not checked yet.";
  const reason = reasonWords(result, now);
  if (result.asked && !result.olderThanCadence && !result.stale) return reason;
  const when = result.asked ? checkedAgoWords(result.ageMs) : `unchanged since ${whenWords(result.checkedAt, now)}`;
  return `${reason} (${result.stale ? "stale, " : ""}${when})`;
};

/**
 * The counts, as the Set up pane says them (the Set up specification's
 * chosen wording, #573): `8 done, 1 needs attention, 2 skipped`, over the
 * steps the environment registers; a step it does not register is counted
 * nowhere, its name drawn dim instead. The remainder of registered results
 * are pending scheduled reads and counted as checking only while present.
 */
export const countsWords = (counts: SetupCounts): string => {
  const pending = counts.registered - counts.done - counts.needsAttention - counts.skipped;
  return `${counts.done} done, ${counts.needsAttention} ${counts.needsAttention === 1 ? "needs" : "need"} attention, ${counts.skipped} skipped${pending > 0 ? `, ${pending} checking` : ""}`;
};

/**
 * The result that passed before one that could not check, beneath it,
 * dated (ADR 0031): `Last good, checked 2 h ago: <its line>`, its age counted
 * against `now`, the environment's time as this client reckons it.
 */
export const lastGoodWords = (lastGood: LastGood, now: Date): string =>
  `Last good, ${checkedAgoWords(Math.max(0, now.getTime() - Date.parse(lastGood.checkedAt)))}: ${lastGood.reason}`;

/**
 * Why the results are not known to hold now (the Set up specification,
 * "Running checks": unreachable is the client's to see), naming the
 * environment; undefined while it can be reached.
 */
export const setupReachWords = (reach: SetupReach, name: string): string | undefined => {
  switch (reach.status) {
    case "reachable":
      return undefined;
    case "service-down":
      return `${name} is not running: its results are from before it stopped.`;
    case "unreachable":
      return reach.since === null ? `${name} has not been reached yet.` : `${name} has not been reached since ${clockTime(reach.since)}: its results are from before.`;
  }
};
