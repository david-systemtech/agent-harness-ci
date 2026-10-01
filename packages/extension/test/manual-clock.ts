import type { Clock } from "../src/clock.js";

/**
 * A clock the test moves: the worker's retries and pings wait on it, so a
 * test says when 20 seconds have passed rather than waiting them out.
 */
export interface ManualClock extends Clock {
  /** Moves the time on by `ms`, running each timer that falls due, in order. */
  advance(ms: number): void;
  /** How many timers wait now. */
  pending(): number;
}

export const manualClock = (): ManualClock => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  return {
    after(ms, run) {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return () => void timers.delete(id);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.run();
      }
      now = until;
    },
    pending: () => timers.size,
  };
};
