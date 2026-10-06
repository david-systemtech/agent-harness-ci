import { windowWords, type UsageGauge } from "@agent-harness/client-runtime";
import { isKnownUsageWindow } from "@agent-harness/contracts";

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

const share = (moved: number): string => `${(Math.round(moved * 1000) / 10).toFixed(1)}%`;

/**
 * The windows that moved between `before` and `after`, as words ("1.2% of
 * the 5-hour window"), unknown limits folded into one ("up to 1.0% of other
 * limits") so the line never repeats a label; null while no window has been
 * observed since `before`, so the difference is not taken yet.
 */
export const planDelta = (before: PlanMark, after: PlanMark): readonly string[] | null => {
  let observed = false;
  const words: string[] = [];
  const others: (readonly [string, number])[] = [];
  for (const [window, then] of before) {
    const now = after.get(window);
    if (now === undefined || Date.parse(now.observedAt) <= Date.parse(then.observedAt)) continue;
    observed = true;
    const moved = now.utilisation - then.utilisation;
    if (moved < PLAN_DELTA_FLOOR) continue;
    if (isKnownUsageWindow(window)) words.push(`${share(moved)} of the ${windowWords(window)} window`);
    else others.push([window, moved]);
  }
  const [other] = others;
  if (other !== undefined && others.length === 1) words.push(`${share(other[1])} of the ${windowWords(other[0])} window`);
  if (others.length > 1) words.push(`up to ${share(Math.max(...others.map(([, moved]) => moved)))} of other limits`);
  return observed ? words : null;
};
