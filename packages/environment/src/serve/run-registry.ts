import { ContractError, type BusyReason, type EnvironmentActivity } from "@agent-harness/contracts";
import type { Clock } from "./clock.js";

/**
 * The runs the lifecycle reads (env spec, "Lifecycle"; ADR 0007): the seam
 * the adapter host (`adapter/host.ts`) fills, the in-memory registry it
 * fills, and the idle rule over them.
 */

/** A run that started or ended this recently keeps the environment busy (ADR 0007). */
export const IDLE_WINDOW_MS = 10 * 60_000;

/** A run parked on a prompt counts as busy for this long after it parked, and no longer (ADR 0007). */
export const PARKED_PROMPT_WINDOW_MS = 10 * 60_000;

/** One run as the registry reports it: its state, and the instants the idle rule reads. */
export type RunRecord =
  | { readonly id: string; readonly state: "starting" | "running"; readonly startedAt: Date }
  | { readonly id: string; readonly state: "parked"; readonly startedAt: Date; readonly parkedSince: Date }
  | { readonly id: string; readonly state: "ended"; readonly startedAt: Date; readonly endedAt: Date };

/**
 * What the lifecycle needs of the adapter host's runs, and the drain's
 * admission gate. `runs` lists every run not ended, and every run that ended
 * within `IDLE_WINDOW_MS`; `onChange` hears every change of state. The host
 * calls `admit` before it starts a run: once the drain has called
 * `refuseNewRuns`, `admit` throws `unavailable {readiness: draining}`, which
 * the request that asked for the run is answered with.
 */
export interface RunRegistry {
  runs(): Iterable<RunRecord>;
  /** Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  refuseNewRuns(): void;
  admit(): void;
}

/**
 * The in-memory registry: the one the adapter host records its runs in, as
 * they start, run and end, and the one tests drive directly. Each change is
 * stamped with the clock and heard by every listener. An ended run is
 * forgotten once it no longer counts.
 */
export interface MemoryRunRegistry extends RunRegistry {
  /** A new run, starting: admitted first, so it is refused while the environment drains. */
  start(id: string): void;
  running(id: string): void;
  /** The run waits on a permission prompt or a question nobody has answered yet. */
  park(id: string): void;
  /** The prompt was answered and the run runs again. */
  resume(id: string): void;
  end(id: string): void;
}

export const createRunRegistry = (options: { readonly clock: Pick<Clock, "now"> }): MemoryRunRegistry => {
  const { clock } = options;
  const runs = new Map<string, RunRecord>();
  const listeners = new Set<() => void>();
  let refusing = false;

  const changed = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("A run registry listener threw:", error);
      }
    }
  };
  const find = (id: string): RunRecord => {
    const run = runs.get(id);
    if (!run) throw new Error(`No run ${id} is in the registry.`);
    return run;
  };
  const put = (run: RunRecord): void => {
    runs.set(run.id, run);
    changed();
  };
  const admit = (): void => {
    if (!refusing) return;
    throw new ContractError({
      code: "unavailable",
      message: "The environment is draining and starts no new runs.",
      data: { readiness: "draining" },
    });
  };

  return {
    runs() {
      const now = clock.now().getTime();
      for (const run of [...runs.values()]) {
        if (run.state === "ended" && run.endedAt.getTime() + IDLE_WINDOW_MS <= now) runs.delete(run.id);
      }
      return [...runs.values()];
    },
    onChange(listener) {
      const own = () => listener();
      listeners.add(own);
      return () => void listeners.delete(own);
    },
    refuseNewRuns() {
      refusing = true;
    },
    admit,
    start(id) {
      admit();
      if (runs.has(id)) throw new Error(`A run ${id} is already in the registry.`);
      put({ id, state: "starting", startedAt: clock.now() });
    },
    running: (id) => put({ id, state: "running", startedAt: find(id).startedAt }),
    park: (id) => put({ id, state: "parked", startedAt: find(id).startedAt, parkedSince: clock.now() }),
    resume: (id) => put({ id, state: "running", startedAt: find(id).startedAt }),
    end: (id) => put({ id, state: "ended", startedAt: find(id).startedAt, endedAt: clock.now() }),
  };
};

/** The reasons a window of time holds the environment busy, rather than a run under way. */
type WindowReason = Extract<BusyReason, "parked-prompt" | "recent-activity">;

/**
 * The idle rule (ADR 0007, the glossary's Idle), a pure function of the runs
 * and the time: busy while a run is starting or running; otherwise busy
 * until ten minutes after the latest start or end of any run
 * (`recent-activity`, which a parked run holds too, from its start) or after
 * the parking of a run still parked (`parked-prompt`), with `busyUntil` the
 * later of them and the reason the one that holds longest (a parked prompt
 * on a tie); otherwise idle. A window ends at its instant: ten minutes on,
 * the run no longer counts.
 */
export const activityOf = (runs: Iterable<RunRecord>, now: Date): Exclude<EnvironmentActivity, { state: "draining" }> => {
  const at = now.getTime();
  let starting = false;
  let running = false;
  let until = -Infinity;
  let reason: WindowReason | undefined;
  const hold = (instant: Date, windowMs: number, why: WindowReason): void => {
    const end = instant.getTime() + windowMs;
    if (end <= at) return;
    if (end > until || (end === until && why === "parked-prompt")) {
      until = end;
      reason = why;
    }
  };
  for (const run of runs) {
    if (run.state === "starting") starting = true;
    if (run.state === "running") running = true;
    hold(run.startedAt, IDLE_WINDOW_MS, "recent-activity");
    if (run.state === "ended") hold(run.endedAt, IDLE_WINDOW_MS, "recent-activity");
    if (run.state === "parked") hold(run.parkedSince, PARKED_PROMPT_WINDOW_MS, "parked-prompt");
  }
  if (starting) return { state: "busy", reason: "run-starting" };
  if (running) return { state: "busy", reason: "run-running" };
  if (reason) return { state: "busy", reason, busyUntil: new Date(until).toISOString() };
  return { state: "idle" };
};
