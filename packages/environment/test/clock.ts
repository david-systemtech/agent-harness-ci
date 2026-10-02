import type { Clock } from "../src/serve/clock.js";

/** A clock that stands still until `advance` moves it; the environment's timers run as it passes them. */
export interface ManualClock extends Clock {
  /**
   * Moves time on by `ms`, running every timer that falls due on the way, in
   * the order they fall due (and in the order they were set when two fall due
   * together), each with `now` at its due time. A timer set by a callback runs
   * too if it falls due before the end.
   */
  advance(ms: number): void;
  /**
   * Moves the wall clock by `ms`, either way, as a machine's sleep or a clock
   * set by hand moves `Date.now()`, running no timer: each keeps the time it
   * had left, as Node's timers on Linux's monotonic clock do through a
   * suspend (#527).
   */
  jump(ms: number): void;
  /** How many timers are scheduled. */
  pending(): number;
}

interface Scheduled {
  readonly id: number;
  due: number;
  readonly every: number | undefined;
  readonly callback: () => void;
}

/** The instant a manual clock starts at unless told otherwise. */
export const MANUAL_CLOCK_START = "2026-09-24T00:00:00.000Z";

export const manualClock = (start: Date | string = MANUAL_CLOCK_START): ManualClock => {
  let now = new Date(start).getTime();
  let nextId = 1;
  const timers = new Map<number, Scheduled>();

  const schedule = (callback: () => void, ms: number, every: number | undefined) => {
    if (!(ms >= 0)) throw new RangeError(`A delay is 0 ms or more; got ${ms}.`);
    const timer: Scheduled = { id: nextId++, due: now + ms, every, callback };
    timers.set(timer.id, timer);
    return { cancel: () => void timers.delete(timer.id) };
  };

  const nextDue = (until: number): Scheduled | undefined => {
    let first: Scheduled | undefined;
    for (const timer of timers.values()) {
      if (timer.due > until) continue;
      if (!first || timer.due < first.due || (timer.due === first.due && timer.id < first.id)) first = timer;
    }
    return first;
  };

  return {
    now: () => new Date(now),
    setTimeout: (callback, ms) => schedule(callback, ms, undefined),
    setInterval: (callback, ms) => {
      if (!(ms > 0)) throw new RangeError(`An interval is more than 0 ms; got ${ms}.`);
      return schedule(callback, ms, ms);
    },
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError(`Time moves forward; got ${ms} ms.`);
      const until = now + ms;
      for (let timer = nextDue(until); timer; timer = nextDue(until)) {
        now = timer.due;
        if (timer.every === undefined) timers.delete(timer.id);
        else timer.due += timer.every;
        timer.callback();
      }
      now = until;
    },
    jump(ms) {
      now += ms;
      for (const timer of timers.values()) timer.due += ms;
    },
    pending: () => timers.size,
  };
};
