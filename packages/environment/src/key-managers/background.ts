/**
 * The key managers' background work (#745): what the connections take up
 * off any request, which nothing awaits (a login's renewal, a verification
 * with the sign-in it makes, a run token's renewal, a revocation), each run
 * through here so that `settled` can wait on all of it. That is what a test
 * on a held clock waits on after it moves the clock on and before it looks:
 * a renewal the clock set off answered and the next one planned, a login
 * due signed in again and the one it replaced revoked.
 */
export interface BackgroundWork {
  /** Takes up `work`, which deals with its own failure. */
  run(work: Promise<unknown>): void;
  /** Settles once every piece taken up so far has ended, with every piece those took up before they ended. */
  settled(): Promise<void>;
}

export const createBackgroundWork = (): BackgroundWork => {
  const running = new Set<Promise<unknown>>();
  return {
    run(work) {
      const piece: Promise<unknown> = work.finally(() => running.delete(piece));
      running.add(piece);
    },
    async settled() {
      while (running.size > 0) await Promise.allSettled(running);
    },
  };
};
