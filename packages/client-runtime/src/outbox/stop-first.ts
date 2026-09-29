import { liveRunIdOf } from "../composer/send.js";
import type { Observable } from "../observable.js";
import type { Clock } from "../platform.js";
import type { SessionRunsView } from "../projections/runs.js";
import type { SessionProjection } from "../projections/session.js";
import { stopFirstOffer, type VerbAvailability } from "../projections/verbs.js";
import type { DispatchAnswer, RewindAnswer } from "./outbox.js";

/**
 * `commands.rewind`'s stop-first form (#390; ADR 0022; #232's rule, moved
 * from the terminal UI so every client stops and rewinds alike): while a run
 * is live the environment refuses a rewind (`run_active`), and the wire has no
 * stop-and-rewind of its own, so the runtime sends `runs.interrupt`, waits
 * until the run it stopped is no longer the session's live run, and then
 * rewinds as the plain form does (a `use_new_session` refusal included).
 *
 * - It never starts while messages are queued, since the stop leaves them
 *   for the next run and the rewind would be refused over them, nor while
 *   the run is only starting, with no id to interrupt: it is refused at
 *   once, dispatching nothing (`stopFirstOffer`). A rewind absent for any
 *   other reason (the adapter's, the connection's) is refused the same way,
 *   stopping nothing; with no run live it is the plain rewind.
 * - The wait holds while the environment is out of reach, where the run may
 *   still be live, and while the session's stream catches up after a
 *   reconnect, when what the runtime holds of it is not yet the
 *   environment's word; it ends `STOP_WAIT_MS` after the interrupt was accepted:
 *   the rewind is given up, having rewound nothing. It does not end because a
 *   renderer shows another session: the rewind was asked for, and goes.
 * - The runtime closing ends the wait: the rewind is then refused `closed`.
 */

/**
 * How long a stop-first rewind waits for the run it stopped to end before it
 * gives the rewind up: a chosen default, well past the 8 s the Claude adapter
 * gives an interrupt before it forces its process down.
 */
export const STOP_WAIT_MS = 30_000;

export interface StopFirstHost {
  readonly clock: Clock;
  /** What the runtime holds of the session, read without subscribing. */
  held(environmentId: string, sessionId: string): SessionProjection;
  /** The session's run state, queue and verbs (`projections.runs.session`): following it holds the session while the rewind waits. */
  sessionRuns(environmentId: string, sessionId: string): Observable<SessionRunsView>;
  /** `runs.interrupt` through the outbox. */
  interrupt(environmentId: string, runId: string): Promise<DispatchAnswer<"runs.interrupt">>;
  /** The plain rewind. */
  rewind(environmentId: string, sessionId: string, messageId: string): Promise<RewindAnswer>;
}

export interface StopFirst {
  rewind(environmentId: string, sessionId: string, messageId: string, onStopping?: (runId: string) => void): Promise<RewindAnswer>;
  /** Ends every wait: each goes on to its rewind, which the closed outbox refuses. */
  close(): void;
}

/** Whether a verb's answer is the connection's refusal: the environment out of reach, or not ready. */
const outOfReach = (availability: VerbAvailability): boolean =>
  availability.status === "absent" && (availability.reason === "unreachable" || availability.reason === "not-ready");

export const createStopFirst = (host: StopFirstHost): StopFirst => {
  /** The waits under way, each ended with whether the run is over. */
  const waits = new Set<(over: boolean) => void>();

  /** Resolves true once `runId` is no longer the live run of the session as its live stream shows it, and the environment is reachable; false after `STOP_WAIT_MS`. */
  const ended = (environmentId: string, sessionId: string, runId: string): Promise<boolean> =>
    new Promise((resolve) => {
      const runs = host.sessionRuns(environmentId, sessionId);
      let stop = (): void => undefined;
      const finish = (over: boolean) => {
        if (!waits.delete(finish)) return;
        timer.cancel();
        stop();
        resolve(over);
      };
      const check = () => {
        const view = runs.read();
        const held = host.held(environmentId, sessionId);
        if (held.freshness === "live" && liveRunIdOf(held, view) !== runId && !outOfReach(view.verbs.rewind)) finish(true);
      };
      waits.add(finish);
      const timer = host.clock.setTimeout(() => finish(false), STOP_WAIT_MS);
      stop = runs.subscribe(check);
      // Over while it subscribed: the subscription goes at once; else it is looked at now, as nothing may change again.
      if (!waits.has(finish)) stop();
      else check();
    });

  return {
    async rewind(environmentId, sessionId, messageId, onStopping) {
      const view = host.sessionRuns(environmentId, sessionId).read();
      const offer = stopFirstOffer(view, liveRunIdOf(host.held(environmentId, sessionId), view));
      if (offer.stops === null) {
        if (offer.rewind.status === "present") return host.rewind(environmentId, sessionId, messageId);
        return { kind: "refused", reason: offer.rewind.reason, message: offer.rewind.message };
      }
      const runId = offer.stops;
      const interrupted = await host.interrupt(environmentId, runId);
      if (!interrupted.ok) return { kind: "interrupt", answer: interrupted };
      onStopping?.(runId);
      if (!(await ended(environmentId, sessionId, runId))) return { kind: "gave-up", runId };
      return host.rewind(environmentId, sessionId, messageId);
    },
    close() {
      for (const finish of [...waits]) finish(true);
    },
  };
};
