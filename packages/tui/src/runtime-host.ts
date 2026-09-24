import { writable, type Observable, type Runtime } from "@agent-harness/client-runtime";

/**
 * Holds the one client runtime the terminal UI renders from. A runtime
 * learns its local environment from the grant at start; one whose service
 * was down at its first start, never seen before, lists nothing to retry
 * (docs/specs/client-runtime.md, the #126 notes, "Owed"). Once the terminal
 * UI has started that service, it starts a fresh runtime on the same
 * platform, which finds the grant: `restart`.
 */
export interface RuntimeHost {
  /** The runtime now; a restart replaces it. */
  readonly current: Observable<Runtime>;
  /** Whether the current runtime's start has settled, so an empty list means nothing is known rather than not yet. */
  readonly started: Observable<boolean>;
  /** Starts the current runtime; a failed start is reported and may be tried again. */
  start(): Promise<void>;
  /** Closes the current runtime, makes a fresh one and starts it. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export const createRuntimeHost = (make: () => Runtime): RuntimeHost => {
  const current = writable(make());
  const started = writable(false);
  let closed = false;
  const start = async () => {
    const runtime = current.read();
    await runtime.start();
    if (current.read() === runtime) started.set(true);
  };
  return {
    current,
    started,
    start,
    async restart() {
      if (closed) return;
      const previous = current.read();
      started.set(false);
      current.set(make());
      await previous.close();
      await start();
    },
    async close() {
      closed = true;
      await current.read().close();
    },
  };
};
