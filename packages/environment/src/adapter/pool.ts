import {
  PROCESS_IDLE_MINUTES_PRESET,
  ProcessIdleMinutes,
  type ProcessHold,
  type ProcessHoldKind,
  type ProcessState,
  type ProcessStopReason,
  type ProviderProcess,
} from "@agent-harness/contracts";
import type { Clock, Timer } from "../serve/clock.js";
import type { ProcessPort } from "./contract.js";

/**
 * The provider-process pool (claude-adapter spec, "Environment-owned
 * provider processes"; ADR 0015): the environment's record of the one
 * provider process each session's runs share, and the rules that stop it.
 * The adapter holds the process itself, keyed by session (`createRun` starts
 * or reuses it, `stopProcess` stops it); the pool decides when it stops. The
 * adapter host drives it as runs begin, answer, park and end, and hands each
 * run the port its adapter reports held work through.
 *
 * States: `starting` from a cold run's begin until the provider answers,
 * `busy` while a turn runs, `parked` while the turn waits on a raised
 * prompt, `idle` between turns, then `stopping` and `stopped`. A process
 * idle for the idle time with no held work (a live background task, a
 * registered schedule) stops, the time counted from the end of its last
 * turn or the release of its last hold, whichever is later; a process parked
 * for the idle time is handed to the host, which ends its run `interrupted`
 * with cause `parked` and stops it. Each wait is one timer on the
 * environment's clock, armed when it begins and cancelled when it ends, so a
 * stop falls exactly on its instant and nothing wakes while nothing waits.
 * Once the environment drains, an idle process stops at once and a busy one
 * as its turn ends. A stopped process is listed for ten minutes; the
 * session's next run starts a new one, cold. Nothing is pre-warmed.
 */

/** How long a stopped process stays in the list after it stopped. */
export const STOPPED_LISTED_MS = 10 * 60_000;

export interface ProcessPoolOptions {
  readonly clock: Clock;
  /**
   * The idle time, in minutes: `providers.processIdleMinutes`, read each time
   * a wait begins, so a change applies to the waits that begin after it.
   * Preset: the setting's preset. A value outside the setting's range is
   * logged and the preset used.
   */
  readonly idleMinutes?: () => number;
  /** Stops the session's process at the adapter of `provider`; resolves once it has stopped. */
  readonly stopProcess: (sessionId: string, provider: string) => void | Promise<void>;
  /** The session's process has been parked for the idle time: the host ends its run `interrupted`, cause `parked`, and stops it. */
  readonly onParkedTooLong: (sessionId: string) => void;
}

export interface ProcessPool {
  /** A run begins on the session: its idle process turns busy, or a new one starts, cold. */
  begin(sessionId: string, provider: string, runId: string): void;
  /** The run's provider has answered (its first event): a starting process is busy. */
  answered(sessionId: string, runId: string): void;
  /** The run waits on a raised prompt. */
  park(sessionId: string, runId: string): void;
  /** The run's prompts are answered: it is busy again. */
  unpark(sessionId: string, runId: string): void;
  /** The run's turn ended: its process is idle, and stops after the idle time unless held; while draining it stops now. */
  end(sessionId: string, runId: string): void;
  /** The port a run's adapter reports held work through, bound to the session's process as it is now. */
  port(sessionId: string): ProcessPort;
  /** Whether the session has a process that is not stopping or stopped. */
  running(sessionId: string): boolean;
  /** Stops the session's process, if it has one running; resolves once it has stopped. */
  stop(sessionId: string, reason: ProcessStopReason): Promise<void>;
  /** The environment drains: every idle process stops now, and every busy one as its turn ends. */
  drain(): void;
  /** Stops every process with `reason` and takes no more; resolves once every stop under way has finished. */
  close(reason: ProcessStopReason): Promise<void>;
  /** Every process, a stopped one for ten minutes after it stopped, in the order they started. */
  list(): ProviderProcess[];
}

/** One process as the pool records it. */
interface ProcessEntry {
  readonly sessionId: string;
  readonly provider: string;
  state: ProcessState;
  runId: string | null;
  readonly startedAt: number;
  lastBusyAt: number;
  /** When its idle time counts from, while idle. */
  idleSince: number | null;
  parkedSince: number | null;
  /** Held work, by `kind:id`, oldest first. */
  readonly holds: Map<string, ProcessHold>;
  /** When the armed wait ends, while one is. */
  stopsAt: number | null;
  timer: Timer | undefined;
  stoppedAt: number | null;
  stopReason: ProcessStopReason | null;
  /** Settles once its stop has finished. */
  stopped: Promise<void> | undefined;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export const createProcessPool = (options: ProcessPoolOptions): ProcessPool => {
  const { clock } = options;
  const entries = new Map<string, ProcessEntry>();
  let draining = false;
  let closed = false;

  const now = (): number => clock.now().getTime();

  const idleMs = (): number => {
    let minutes: unknown = PROCESS_IDLE_MINUTES_PRESET;
    try {
      minutes = options.idleMinutes?.() ?? PROCESS_IDLE_MINUTES_PRESET;
    } catch (error) {
      console.error("Reading providers.processIdleMinutes failed; the preset holds:", error);
    }
    const parsed = ProcessIdleMinutes.safeParse(minutes);
    if (!parsed.success) console.error(`providers.processIdleMinutes read ${String(minutes)}, which it does not take; the preset holds.`);
    return (parsed.success ? parsed.data : PROCESS_IDLE_MINUTES_PRESET) * 60_000;
  };

  /** The session's process unless it is stopping or stopped. */
  const runningEntry = (sessionId: string): ProcessEntry | undefined => {
    const entry = entries.get(sessionId);
    return entry === undefined || entry.state === "stopping" || entry.state === "stopped" ? undefined : entry;
  };

  /** The session's process while `runId` is its run. */
  const entryOfRun = (sessionId: string, runId: string): ProcessEntry | undefined => {
    const entry = runningEntry(sessionId);
    return entry?.runId === runId ? entry : undefined;
  };

  const disarm = (entry: ProcessEntry): void => {
    entry.timer?.cancel();
    entry.timer = undefined;
    entry.stopsAt = null;
  };

  /** Arms the entry's one wait: the idle time from `from`, then `fire`. */
  const arm = (entry: ProcessEntry, from: number, fire: () => void): void => {
    disarm(entry);
    const stopsAt = from + idleMs();
    entry.stopsAt = stopsAt;
    entry.timer = clock.setTimeout(() => {
      entry.timer = undefined;
      fire();
    }, Math.max(0, stopsAt - now()));
  };

  /** An idle process with no held work waits out its idle time, then stops. */
  const waitIdle = (entry: ProcessEntry): void => {
    if (entry.state !== "idle" || entry.holds.size > 0 || entry.idleSince === null) return disarm(entry);
    arm(entry, entry.idleSince, () => {
      if (entry.state === "idle" && entry.holds.size === 0) void stop(entry, "idle");
    });
  };

  /** A parked process waits out its idle time, then is handed to the host. */
  const waitParked = (entry: ProcessEntry): void => {
    if (entry.state !== "parked" || entry.parkedSince === null) return disarm(entry);
    arm(entry, entry.parkedSince, () => {
      if (entry.state !== "parked") return;
      try {
        options.onParkedTooLong(entry.sessionId);
      } catch (error) {
        console.error(`Ending the parked run of session ${entry.sessionId} failed:`, error);
      }
      // The host stops it with its run; if it could not, the pool does.
      if (runningEntry(entry.sessionId) === entry) void stop(entry, "parked");
    });
  };

  const stop = (entry: ProcessEntry, reason: ProcessStopReason): Promise<void> => {
    if (entry.stopped !== undefined) return entry.stopped;
    disarm(entry);
    // A turn on it ends with it.
    if (entry.runId !== null) entry.lastBusyAt = now();
    entry.state = "stopping";
    entry.stopReason = reason;
    entry.runId = null;
    entry.parkedSince = null;
    entry.idleSince = null;
    entry.holds.clear();
    entry.stopped = (async () => {
      try {
        await options.stopProcess(entry.sessionId, entry.provider);
      } catch (error) {
        console.error(`Stopping the provider process of session ${entry.sessionId} failed; the environment no longer uses it:`, error);
      }
      entry.state = "stopped";
      entry.stoppedAt = now();
    })();
    return entry.stopped;
  };

  const port = (entry: ProcessEntry): ProcessPort => ({
    hold(kind: ProcessHoldKind, id: string) {
      if (entry.state === "stopping" || entry.state === "stopped") return;
      const key = `${kind}:${id}`;
      if (entry.holds.has(key)) return;
      entry.holds.set(key, { kind, id });
      if (entry.state === "idle") disarm(entry);
    },
    unhold(kind: ProcessHoldKind, id: string) {
      if (entry.state === "stopping" || entry.state === "stopped") return;
      if (!entry.holds.delete(`${kind}:${id}`) || entry.holds.size > 0 || entry.state !== "idle") return;
      entry.idleSince = now();
      if (draining) void stop(entry, "drain");
      else waitIdle(entry);
    },
  });

  /** A port that holds nothing, for a session with no process running. */
  const noPort: ProcessPort = { hold: () => undefined, unhold: () => undefined };

  const list = (): ProviderProcess[] => {
    const at = now();
    for (const [sessionId, entry] of [...entries]) {
      if (entry.state === "stopped" && entry.stoppedAt !== null && entry.stoppedAt + STOPPED_LISTED_MS <= at) entries.delete(sessionId);
    }
    return [...entries.values()].map((entry) => ({
      sessionId: entry.sessionId,
      provider: entry.provider,
      state: entry.state,
      runId: entry.runId,
      startedAt: iso(entry.startedAt) as string,
      lastBusyAt: iso(entry.lastBusyAt) as string,
      parkedSince: iso(entry.parkedSince),
      holds: [...entry.holds.values()],
      stopsAt: iso(entry.stopsAt),
      stoppedAt: iso(entry.stoppedAt),
      stopReason: entry.stopReason,
    }));
  };

  return {
    begin(sessionId, provider, runId) {
      if (closed) return;
      const at = now();
      const entry = runningEntry(sessionId);
      if (entry !== undefined) {
        disarm(entry);
        entry.state = "busy";
        entry.runId = runId;
        entry.lastBusyAt = at;
        entry.idleSince = null;
        entry.parkedSince = null;
        return;
      }
      // Cold: a new process, in place of any stopped one; the map's order is the order processes started.
      entries.delete(sessionId);
      entries.set(sessionId, {
        sessionId,
        provider,
        state: "starting",
        runId,
        startedAt: at,
        lastBusyAt: at,
        idleSince: null,
        parkedSince: null,
        holds: new Map(),
        stopsAt: null,
        timer: undefined,
        stoppedAt: null,
        stopReason: null,
        stopped: undefined,
      });
    },
    answered(sessionId, runId) {
      const entry = entryOfRun(sessionId, runId);
      if (entry?.state === "starting") entry.state = "busy";
    },
    park(sessionId, runId) {
      const entry = entryOfRun(sessionId, runId);
      if (entry === undefined || entry.state === "parked") return;
      entry.state = "parked";
      entry.parkedSince = now();
      waitParked(entry);
    },
    unpark(sessionId, runId) {
      const entry = entryOfRun(sessionId, runId);
      if (entry?.state !== "parked") return;
      disarm(entry);
      entry.state = "busy";
      entry.parkedSince = null;
    },
    end(sessionId, runId) {
      const entry = entryOfRun(sessionId, runId);
      if (entry === undefined) return;
      const at = now();
      entry.state = "idle";
      entry.runId = null;
      entry.parkedSince = null;
      entry.lastBusyAt = at;
      entry.idleSince = at;
      if (draining) void stop(entry, "drain");
      else waitIdle(entry);
    },
    port(sessionId) {
      const entry = runningEntry(sessionId);
      return entry === undefined ? noPort : port(entry);
    },
    running: (sessionId) => runningEntry(sessionId) !== undefined,
    stop(sessionId, reason) {
      const entry = entries.get(sessionId);
      return entry === undefined ? Promise.resolve() : stop(entry, reason);
    },
    drain() {
      draining = true;
      for (const entry of entries.values()) if (entry.state === "idle") void stop(entry, "drain");
    },
    async close(reason) {
      closed = true;
      await Promise.all([...entries.values()].map((entry) => stop(entry, reason)));
    },
    list,
  };
};
