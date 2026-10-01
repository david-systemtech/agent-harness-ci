import { randomUUID } from "node:crypto";
import { ENVIRONMENT_STREAM_KIND, ROUTINE_STREAM_KIND, dueTimesBetween, nextDueAt, type RoutineTrigger } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import { plainSkip, recordSkip, type FiringStarter } from "./firing-start.js";
import { handledInstant } from "./listing.js";
import { listStoredRoutines, type StoredRoutine } from "./routine-store.js";

/**
 * The scheduler (routines spec, "The scheduler"; ADR 0008; #527): one per
 * environment, in the environment process, firing its routines with no
 * client connected. It keeps one timer for the earliest due time across the
 * enabled routines, re-armed on every create, edit, enable, disable and
 * delete and at the end of every firing, and checks the environment's clock
 * every 60 seconds, which finds the due times a machine's sleep or a clock's
 * jump passed while the timer waited: the timers run on the monotonic clock,
 * the due times on the wall clock.
 *
 * Each due time after a routine's `handledThrough` is handled once, as a
 * firing or a skip, which the routine store records and raises
 * `handledThrough` by; the due times handed on and not recorded yet are
 * held in memory, so none is handed on twice. A due time found on time,
 * within two minutes, fires with trigger `schedule` through the firing
 * starter, which runs its pre-check first, skips it `overlap` while a firing
 * of its routine is live and holds it while four firings are. Those found
 * later (a machine that slept, an environment that was down) collapse into
 * the latest: with `ifMissed: run-once` and within seven days it fires now
 * with trigger `catch-up`, else it is skipped `missed`; its `count` says how
 * many due times it stands for.
 *
 * `start` is the start pass: the missed rule over every enabled routine,
 * then the timer and the check armed.
 */

/** How often the scheduler checks the environment's clock (routines spec, "Chosen defaults"). */
export const SCHEDULER_CHECK_MS = 60_000;
/** How late a due time may be found and still fire on time; later, it is missed. */
export const MISSED_AFTER_MS = 2 * 60_000;
/** How old the latest missed due time may be for `ifMissed: run-once` to fire it. */
export const CATCH_UP_WITHIN_MS = 7 * 24 * 60 * 60_000;

/** The routine records whose commit re-arms the timer: the commands', and a firing's end. */
const REARMING: ReadonlySet<string> = new Set(["routine.created", "routine.edited", "routine.enabled", "routine.disabled", "routine.deleted", "routine.firing-ended"]);

export interface RoutineSchedulerOptions {
  readonly log: EventLog;
  /** The environment's clock: its wall clock says what is due, and its timers wait. */
  readonly clock: Clock;
  /** The environment's id: its stream carries a missed skip's `routine.updated`. */
  readonly environmentId: string;
  /** What starts a firing, waiting for a slot and skipping an overlap. */
  readonly firings: Pick<FiringStarter, "start">;
}

export interface RoutineScheduler {
  /** The start pass: applies the missed rule, then arms the timer and the 60-second check, following the routines' changes. */
  start(): void;
  /** Stops the timer and the check; a due time from then on stays unhandled for the next start's missed rule. */
  stop(): void;
}

export const createRoutineScheduler = ({ log, clock, environmentId, firings }: RoutineSchedulerOptions): RoutineScheduler => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** For each routine, the latest due time handed on, in milliseconds: its record may not have committed yet. */
  const handedOn = new Map<string, number>();
  let timer: Timer | null = null;
  let check: Timer | null = null;
  let unsubscribe: (() => void) | null = null;
  /** The earliest due time the timer waits for, in milliseconds; null when no routine is due ever. */
  let earliest: number | null = null;

  /** The enabled routines, each with the instant after which its due times are owed; what is gone is forgotten. */
  const scheduled = (): { readonly routine: StoredRoutine; readonly after: number }[] => {
    const routines = listStoredRoutines(reader);
    const present = new Set(routines.map((routine) => routine.state.id));
    for (const id of handedOn.keys()) if (!present.has(id)) handedOn.delete(id);
    return routines
      .filter((routine) => routine.definition.enabled)
      .map((routine) => ({ routine, after: Math.max(handledInstant(routine.state), handedOn.get(routine.state.id) ?? -Infinity) }));
  };

  /** Hands a due time to the firing starter: the routine's definition and saved ceiling as they are now, its pre-check first. */
  const fire = ({ definition, state }: StoredRoutine, dueAt: number, trigger: RoutineTrigger, count: number): void =>
    firings.start({
      routineId: state.id,
      definition,
      firingId: randomUUID(),
      trigger,
      dueAt: new Date(dueAt).toISOString(),
      count,
      requestedBy: null,
      ceiling: state.savedUnderCeiling,
      withPreCheck: true,
    });

  /** The missed rule for the due times found late, in order: the latest stands for them all, caught up or skipped. */
  const missed = (routine: StoredRoutine, late: readonly number[], now: number): void => {
    const latest = late.at(-1);
    if (latest === undefined) return;
    if (routine.definition.ifMissed === "run-once" && now - latest <= CATCH_UP_WITHIN_MS) return fire(routine, latest, "catch-up", late.length);
    const due = { routineId: routine.state.id, firingId: randomUUID(), trigger: "schedule" as const, dueAt: new Date(latest).toISOString(), count: late.length };
    recordSkip({ log, clock: () => clock.now(), environmentId }, due, plainSkip("missed"));
  };

  /** Sets the one timer for the earliest due time owed; none when no routine is due ever. */
  const arm = (): void => {
    timer?.cancel();
    timer = null;
    const now = clock.now().getTime();
    const next = scheduled()
      .map(({ routine, after }) => nextDueAt(routine.definition, new Date(after))?.getTime() ?? null)
      .filter((due): due is number => due !== null);
    earliest = next.length === 0 ? null : Math.min(...next);
    if (earliest !== null) timer = clock.setTimeout(sweep, Math.max(0, earliest - now));
  };

  /** Handles the routine's due times owed up to `now`, in order: those found late through the missed rule, the rest on time. */
  const handle = (routine: StoredRoutine, after: number, now: number): void => {
    const due = dueTimesBetween(routine.definition, new Date(after), new Date(now)).map((instant) => instant.getTime());
    const last = due.at(-1);
    if (last === undefined) return;
    handedOn.set(routine.state.id, last);
    const late = due.filter((instant) => now - instant > MISSED_AFTER_MS);
    missed(routine, late, now);
    for (const instant of due.slice(late.length)) fire(routine, instant, "schedule", 1);
  };

  /** Handles every due time owed up to now, each routine's in order, then re-arms; a routine whose handling fails is logged and the rest go on. */
  function sweep(): void {
    const now = clock.now().getTime();
    for (const { routine, after } of scheduled()) {
      try {
        handle(routine, after, now);
      } catch (error) {
        console.error(`Handling the due times of the routine ${routine.state.id} failed:`, error);
      }
    }
    arm();
  }

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    timer?.cancel();
    check?.cancel();
    timer = check = null;
  };

  return {
    start() {
      if (unsubscribe !== null) return;
      unsubscribe = log.subscribe((event) => {
        if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "environment.draining") stop();
        else if (event.streamKind === ROUTINE_STREAM_KIND && REARMING.has(event.type)) arm();
      });
      sweep();
      // The wall clock against the due time the timer waits for: a sleep or a jump the timer slept through is found here.
      check = clock.setInterval(() => {
        if (earliest !== null && clock.now().getTime() >= earliest) sweep();
      }, SCHEDULER_CHECK_MS);
    },
    stop,
  };
};
