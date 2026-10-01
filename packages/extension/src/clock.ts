/** The worker's timers, a seam so a test moves time on rather than waiting it out (test/manual-clock.ts). */
export interface Clock {
  /** Runs `run` once `ms` have passed; answers how to cancel it. */
  after(ms: number, run: () => void): () => void;
}

/** The browser's own timers. */
export const systemClock: Clock = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
