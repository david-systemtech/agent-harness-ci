import { windowWords, type UsageGauge } from "@agent-harness/client-runtime";

/**
 * What a turn cost the plan (docs/specs/tui.md, "The transcript": the cost
 * line's plan-window deltas, when reported). Dollars are the wrong unit for someone on a
 * subscription, so a finished turn is also priced in what does run out: a
 * share of the 5-hour window, a share of the week. The projection carries no
 * per-run plan reading (`plan.limit` folds into the account's usage reading,
 * #136), so the terminal takes the difference itself: the
 * session's account's windows as `projections.usage` pools them when the run
 * is first seen running, and again once a window has been observed since.
 * Only a run this terminal saw start has one. Pure.
 */

/** One window's reading: how much is used, and when that was observed. */
export interface WindowMark {
  readonly utilisation: number;
  readonly observedAt: string;
}

export type PlanMark = ReadonlyMap<string, WindowMark>;

/** A move smaller than this is not named: a tenth of a percent. */
export const PLAN_DELTA_FLOOR = 0.001;

/** The gauge's windows that say how much is used. */
export const markOf = (gauge: UsageGauge | undefined): PlanMark => {
  const mark = new Map<string, WindowMark>();
  for (const window of gauge?.windows ?? []) if (window.utilisation !== null) mark.set(window.window, { utilisation: window.utilisation, observedAt: window.observedAt });
  return mark;
};

/**
 * The windows that moved between `before` and `after`, as words ("1.2% of
 * the 5-hour window"); null while no window has been observed since
 * `before`, so the difference is not taken yet.
 */
export const planDelta = (before: PlanMark, after: PlanMark): readonly string[] | null => {
  let observed = false;
  const words: string[] = [];
  for (const [window, then] of before) {
    const now = after.get(window);
    if (now === undefined || Date.parse(now.observedAt) <= Date.parse(then.observedAt)) continue;
    observed = true;
    const moved = now.utilisation - then.utilisation;
    if (moved >= PLAN_DELTA_FLOOR) words.push(`${(Math.round(moved * 1000) / 10).toFixed(1)}% of the ${windowWords(window)} window`);
  }
  return observed ? words : null;
};
