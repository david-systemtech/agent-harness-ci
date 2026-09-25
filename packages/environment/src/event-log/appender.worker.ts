/**
 * A test fixture, not part of the store: one appender for the concurrency
 * test, run on its own worker thread with its own connection. The test loads
 * it through tsx's `tsImport`. It opens the database, reports ready, waits on
 * the shared gate, then sends `rounds` commands to one stream, alternating
 * one-event and three-event commands, each with a receipt, and reports every
 * event it wrote.
 *
 * The receipt lookup reads before the insert writes, which is the path on
 * which a transaction that did not take the write lock up front would lose to
 * the other appender. It pauses a millisecond between commands, which gives
 * the other appender a chance at the write lock and no more: SQLite's busy
 * handler is not a queue. A waiter sleeps and tries again (1, 2, 5 ms and up
 * to every 100 ms), and an appender that takes the lock again a millisecond
 * after each commit can hold it at every try, so one appender can wait out
 * the other's whole run. On a loaded runner that run took longer than the
 * connection's 5 s busy timeout and BEGIN IMMEDIATE threw `database is
 * locked` (#234), which is what `untilNotBusy` is for.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { StreamRef } from "./envelope.js";
import { openEventLog } from "./event-log.js";

export interface AppenderInput {
  readonly name: string;
  readonly path: string;
  readonly stream: StreamRef;
  readonly rounds: number;
  /** One Int32 the test sets to 1 to release every appender at once. */
  readonly gate: SharedArrayBuffer;
}

export interface WrittenEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly streamVersion: number;
  readonly payload: unknown;
}

export type AppenderMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "done"; readonly appends: readonly (readonly WrittenEvent[])[] }
  | { readonly kind: "failed"; readonly error: string };

/** SQLite's SQLITE_BUSY: `node:sqlite` puts the result code on `errcode`, an extended code keeping it in the low byte. */
const SQLITE_BUSY = 5;

const isBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "errcode" in error &&
  typeof error.errcode === "number" &&
  (error.errcode & 0xff) === SQLITE_BUSY;

/** Longer than the other appender's whole run on the slowest runner seen (about 6 s), so only a lock never released gets here. */
const BUSY_DEADLINE_MS = 30_000;

/**
 * Runs `attempt` again while it fails on SQLITE_BUSY, the store's right answer
 * when the other appender held the write lock through the whole busy timeout,
 * which this race can cause by starving a waiter. The failed attempt's
 * BEGIN IMMEDIATE never took the lock, so it wrote nothing, and the command
 * runs again under the same command id; had it committed after all, the retry
 * would come back replayed and the round check below would fail, so the retry
 * cannot hide a lost or doubled write.
 */
const untilNotBusy = <T>(attempt: () => T): T => {
  const deadline = Date.now() + BUSY_DEADLINE_MS;
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (!isBusy(error) || Date.now() > deadline) throw error;
    }
  }
};

const run = (input: AppenderInput, post: (message: AppenderMessage) => void): void => {
  const log = openEventLog({ path: input.path });
  const gate = new Int32Array(input.gate);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  post({ kind: "ready" });
  Atomics.wait(gate, 0, 0);

  const appends: WrittenEvent[][] = [];
  for (let round = 0; round < input.rounds; round++) {
    const size = round % 2 === 0 ? 1 : 3;
    const events = Array.from({ length: size }, (_, i) => ({
      type: "race.step",
      payload: { appender: input.name, round, i },
    }));
    const result = untilNotBusy(() =>
      log.command({ actor: `system:${input.name}`, commandId: `${input.name}-${round}` }, () => ({
        aggregate: input.stream,
        result: null,
        events,
      })),
    );
    if (result.replayed || result.receipt.status !== "accepted" || result.receipt.sequence !== result.events.at(-1)?.sequence) {
      throw new Error(`Round ${round} got a wrong receipt: ${JSON.stringify(result.receipt)}`);
    }
    appends.push(
      result.events.map(({ eventId, sequence, streamVersion, payload }) => ({
        eventId,
        sequence,
        streamVersion,
        payload,
      })),
    );
    Atomics.wait(pause, 0, 0, 1);
  }
  log.close();
  post({ kind: "done", appends });
};

if (!isMainThread && parentPort) {
  const port = parentPort;
  const post = (message: AppenderMessage) => port.postMessage(message);
  try {
    run(workerData as AppenderInput, post);
  } catch (error) {
    post({ kind: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
}
