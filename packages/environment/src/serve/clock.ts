/** A scheduled callback, cancelled by `cancel`; cancelling twice, or after it ran, does nothing. */
export interface Timer {
  cancel(): void;
}

/**
 * The environment's time: what `now` is, and when to run something later.
 * Everything time-driven (the ping interval, the auth timeout, token expiry,
 * the terminal UI sweep, and the idle and drain timers after them) goes
 * through it, so a test can hold time still and move it on by hand.
 */
export interface Clock {
  now(): Date;
  /** Runs `callback` once, `ms` from now. */
  setTimeout(callback: () => void, ms: number): Timer;
  /** Runs `callback` every `ms`, the first time `ms` from now. */
  setInterval(callback: () => void, ms: number): Timer;
}

/** The longest delay Node's own timers take; a longer one would fire at once. */
const MAX_NODE_DELAY_MS = 2 ** 31 - 1;

/** The real clock. A timeout longer than Node's timers take is re-armed in steps, never fired early. */
export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(callback, ms) {
    const due = Date.now() + ms;
    let handle: NodeJS.Timeout;
    const arm = (delay: number) => {
      handle = setTimeout(() => {
        const left = due - Date.now();
        if (left > 0) arm(left);
        else callback();
      }, Math.min(Math.max(delay, 0), MAX_NODE_DELAY_MS));
    };
    arm(ms);
    return { cancel: () => clearTimeout(handle) };
  },
  setInterval(callback, ms) {
    if (!(ms > 0 && ms <= MAX_NODE_DELAY_MS)) throw new RangeError(`An interval takes 1 to ${MAX_NODE_DELAY_MS} ms; got ${ms}.`);
    const handle = setInterval(callback, ms);
    return { cancel: () => clearInterval(handle) };
  },
};
