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
 * the other appender. It pauses a millisecond between commands: SQLite's busy
 * handler backs off while the lock holder takes the lock again at once, so
 * without the pause one appender can starve the other and the two run one
 * after the other instead of interleaving.
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
    const result = log.command({ actor: `system:${input.name}`, commandId: `${input.name}-${round}` }, () => ({
      aggregate: input.stream,
      result: null,
      events,
    }));
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
