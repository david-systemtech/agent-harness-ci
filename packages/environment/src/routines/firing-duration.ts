import { ROUTINE_STREAM_KIND, type RoutineFiringEndedPayload, type RoutineFiringStartedPayload, type RoutineFiringContinuedPayload } from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { liveFiringOfRoutine, routinesWithLiveFirings } from "./routine-store.js";

/**
 * A firing's maximum duration (routines spec, "A firing": Duration; #524):
 * once the `maxDurationMinutes` its `routine.firing-started` recorded have
 * passed on the environment's clock since it started, its live run is
 * interrupted with cause `timeout`, and its end (`firing-end.ts`) fails it
 * `timed_out`, its session left as it is. One timer per firing, armed as its
 * start commits and cancelled as its end does, so a firing that ends before
 * the limit leaves no timer behind; at the limit, only a firing still live
 * has its run interrupted. Timers are restored at start and re-armed on a
 * continuation using the original firing's start, so a restart grants no
 * extra time.
 */

export interface FiringDurationsOptions {
  readonly log: EventLog;
  /** The environment's clock, whose timers wait for each limit. */
  readonly clock: Clock;
  /** What interrupts a firing's run at its limit. */
  readonly host: Pick<AdapterHost, "interrupt">;
}

/**
 * Follows every firing's start and end, interrupting the run of one still
 * live at its limit. Subscribed once the adapter host has started, and
 * closed before it, so no limit reaches a host that has closed. Answers
 * what cancels every timer and stops following.
 */
export const limitFiringDurations = ({ log, clock, host }: FiringDurationsOptions): (() => void) => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** Each live firing's timer, by its id. */
  const timers = new Map<string, Timer>();

  /** At the limit: the routine's live firing, if it is still this one, has its run interrupted; a failure is logged, never thrown from the timer. */
  const reached = (routineId: string, firingId: string): void => {
    timers.delete(firingId);
    try {
      const firing = liveFiringOfRoutine(reader, routineId);
      if (firing?.entry.id === firingId) host.interrupt(firing.entry.runId, "timeout");
    } catch (error) {
      console.error(`Interrupting the firing ${firingId} of the routine ${routineId} at its maximum duration failed:`, error);
    }
  };

  const arm = (routineId: string, firingId: string): void => {
    const firing = liveFiringOfRoutine(reader, routineId);
    if (firing?.entry.id !== firingId) return;
    timers.get(firingId)?.cancel();
    const left = Date.parse(firing.entry.startedAt) + firing.maxDurationMinutes * 60_000 - clock.now().getTime();
    timers.set(firingId, clock.setTimeout(() => reached(routineId, firingId), Math.max(0, left)));
  };

  for (const routineId of routinesWithLiveFirings(reader)) {
    const firing = liveFiringOfRoutine(reader, routineId);
    if (firing !== null) arm(routineId, firing.entry.id);
  }

  const unsubscribe = log.subscribe((event) => {
    if (event.streamKind !== ROUTINE_STREAM_KIND) return;
    if (event.type === "routine.firing-started" || event.type === "routine.firing-continued") {
      const { firingId } = event.payload as RoutineFiringStartedPayload | RoutineFiringContinuedPayload;
      arm(event.streamId, firingId);
    } else if (event.type === "routine.firing-ended") {
      const { firingId } = event.payload as RoutineFiringEndedPayload;
      timers.get(firingId)?.cancel();
      timers.delete(firingId);
    }
  });

  return () => {
    unsubscribe();
    for (const timer of timers.values()) timer.cancel();
    timers.clear();
  };
};
