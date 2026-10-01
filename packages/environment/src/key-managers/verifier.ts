import type { Clock, Timer } from "../serve/clock.js";
import type { BackgroundWork } from "./background.js";

/**
 * When the key-manager connections are verified (key-managers spec, "The
 * connection record"; ADR 0011, ADR 0028, ADR 0031), as the forge
 * accounts' verifier schedules theirs (#311):
 *
 * - **When.** Every connection after startup's gate, then fifteen minutes
 *   after each verification ends, on the environment's clock; at once after
 *   a sign-in or a change; and whenever `keyManagers.connections.verify`
 *   (or a Key manager check, #383) asks. A connection with no credential is
 *   never verified.
 * - **One at a time per connection.** A request while one runs for the
 *   same subject (the credential, login and settings it verifies) joins it;
 *   one for a subject changed since waits for it and verifies again, so what
 *   was found for the one replaced is never taken for the new one.
 *
 * What one verification does and records is the connections'
 * (`verifyNow`); the schedule knows only when.
 */

/** The longest a connection goes without a verification (ADR 0028, as the forge's). */
export const KEY_MANAGER_VERIFY_INTERVAL_MS = 15 * 60_000;

export interface ScheduleOptions {
  readonly clock: Clock;
  /** Every connection the environment holds, by id. */
  readonly connectionIds: () => readonly string[];
  /** What a verification of the connection verifies now; null when it is not verified at all (no credential, or removed). */
  readonly subjectOf: (connectionId: string) => string | null;
  /** One verification of the connection, recording what it found; it never rejects. */
  readonly verifyNow: (connectionId: string) => Promise<void>;
  /** Where each verification runs, asked for or on the clock (#745). */
  readonly background: BackgroundWork;
}

export interface VerificationSchedule {
  /** After startup's gate: every connection verified at once on the clock, then every fifteen minutes. */
  start(): void;
  /** Verifies the connection now, joining one running for the same subject; settles once what it found is recorded. */
  verify(connectionId: string): Promise<void>;
  /** The connection was signed in or changed: it is verified at once, on the environment's clock. */
  changed(connectionId: string): void;
  /** The connection was removed: its schedule is let go. */
  removed(connectionId: string): void;
  /** Stops the schedule; a verification still running records nothing (the connections' part), and none queued behind it starts. */
  close(): void;
}

export const createVerificationSchedule = (options: ScheduleOptions): VerificationSchedule => {
  const { clock, subjectOf } = options;
  const timers = new Map<string, Timer>();
  const runs = new Map<string, { readonly subject: string; readonly done: Promise<void> }>();
  let closed = false;

  const cancel = (connectionId: string): void => {
    timers.get(connectionId)?.cancel();
    timers.delete(connectionId);
  };

  /** Schedules the connection's next verification `ms` from now, unless one is due sooner. */
  const arm = (connectionId: string, ms: number): void => {
    if (closed || timers.has(connectionId)) return;
    timers.set(
      connectionId,
      clock.setTimeout(() => {
        timers.delete(connectionId);
        void verify(connectionId);
      }, ms),
    );
  };

  const verify = (connectionId: string): Promise<void> => {
    const subject = closed ? null : subjectOf(connectionId);
    if (subject === null) return Promise.resolve();
    const running = runs.get(connectionId);
    if (running?.subject === subject) return running.done;
    const done: Promise<void> = (running?.done ?? Promise.resolve())
      .then(() => {
        // This verification is the one that was due: the schedule starts again from its end.
        cancel(connectionId);
        // Queued behind one that outlasted the close, the event log may be closed too; queued behind one that outlasted the credential, nothing is left to verify.
        return closed || subjectOf(connectionId) === null ? undefined : options.verifyNow(connectionId);
      })
      .finally(() => {
        if (runs.get(connectionId)?.done === done) runs.delete(connectionId);
        // Closed, the event log may be too: nothing is read, and nothing is scheduled.
        if (!closed && subjectOf(connectionId) !== null) arm(connectionId, KEY_MANAGER_VERIFY_INTERVAL_MS);
      });
    runs.set(connectionId, { subject, done });
    options.background.run(done);
    return done;
  };

  return {
    start() {
      for (const connectionId of options.connectionIds()) if (subjectOf(connectionId) !== null) arm(connectionId, 0);
    },
    verify,
    changed(connectionId) {
      cancel(connectionId);
      arm(connectionId, 0);
    },
    removed: cancel,
    close() {
      closed = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
};
