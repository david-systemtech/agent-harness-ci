import { FIRST_ROW, type LastGood, type SettingsRowId, type StepState } from "@agent-harness/contracts";
import type { SetupCounts, SetupReach, SetupStepView, SetupView } from "../projections/setup.js";
import { clockTime } from "../transcript/format.js";

/**
 * Set up's checklist as every renderer draws it from `projections.setup`
 * (the Set up specification, "The checklist in the GUI" and "The terminal
 * UI"; ADR 0031; #413): a state in words, the health a row of Settings
 * shows, a step's line, and the counts, so the window and the terminal say
 * the same of one environment (ADR 0004).
 */

/** Each state in words, as a dot is named and a line says it. */
export const STEP_STATE_WORDS: { readonly [State in StepState]: string } = { done: "done", "needs-attention": "needs attention", skipped: "skipped" };

/**
 * How bad each state is, the worst last: a step that needs attention is
 * worse than one done, and one done worse than one skipped, which checked
 * nothing, so a row whose checked steps all pass shows done even beside a
 * step with nothing set up (a chosen default: ADR 0031 names the worst state
 * but not the order of the two that pass).
 */
const SEVERITY: { readonly [State in StepState]: number } = { skipped: 0, done: 1, "needs-attention": 2 };

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
 * How long ago a check ran, in the coarsest unit that says it: `checked 5
 * min ago`, `checked 3 h ago`, `checked 2 d ago`; `checked just now` under a
 * minute.
 */
export const checkedAgoWords = (ageMs: number): string => {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `checked ${hours} h ago` : `checked ${Math.floor(hours / 24)} d ago`;
};

/**
 * A step's line: "Checking…" while this client's own check of it is pending
 * (ADR 0031's half second), else its result's reason, with its age once it
 * is older than its step's cadence; "Not checked yet." with no result.
 */
export const stepLine = (step: SetupStepView): string => {
  if (step.pending) return "Checking…";
  if (step.result === null) return "Not checked yet.";
  return step.result.olderThanCadence ? `${step.result.reason} (${checkedAgoWords(step.result.ageMs)})` : step.result.reason;
};

/** The counts, as the Set up pane says them: `4 done, 1 needs attention, 1 skipped`, and the steps the environment gives no result for. */
export const countsWords = (counts: SetupCounts, steps: number): string => {
  const words = `${counts.done} done, ${counts.needsAttention} ${counts.needsAttention === 1 ? "needs" : "need"} attention, ${counts.skipped} skipped`;
  const unchecked = steps - counts.registered;
  return unchecked === 0 ? `${words}.` : `${words}; ${unchecked} not checked yet.`;
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
