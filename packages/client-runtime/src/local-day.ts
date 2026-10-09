import type { Clock, Timer } from "./platform.js";

/** Wake a visible calendar-relative view at each local midnight, even without fresh data (#1976). */
export const onLocalDayChange = (clock: Clock, changed: () => void): Timer => {
  let cancelled = false;
  const schedule = (): Timer => {
    const now = clock.now();
    const midnight = new Date(now);
    // Calendar arithmetic keeps the wake at midnight on 23- and 25-hour days too.
    midnight.setHours(24, 0, 0, 0);
    return clock.setTimeout(() => {
      changed();
      if (!cancelled) timer = schedule();
    }, midnight.getTime() - now.getTime());
  };
  let timer = schedule();
  return { cancel: () => { cancelled = true; timer.cancel(); } };
};
