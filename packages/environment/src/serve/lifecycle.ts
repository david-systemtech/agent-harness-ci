import { existsSync, readFileSync } from "node:fs";
import {
  ContractError,
  type DrainTrigger,
  type EnvironmentActivity,
  type EnvironmentReadiness,
  type EnvironmentStatus,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "./clock.js";
import type { LauncherQuery, LauncherReply } from "./launcher.js";
import type { MethodHandlers } from "./methods.js";

/**
 * The environment's lifecycle (env spec, "Lifecycle"; ADR 0007): whether it
 * is idle, busy or draining, the drain itself, and whether its updates are
 * managed outside it. Runs are read through the run registry, the seam the
 * adapter host (#119) fills; until then an empty in-memory registry stands in.
 */

/** A run that started or ended this recently keeps the environment busy (ADR 0007). */
export const IDLE_WINDOW_MS = 10 * 60_000;

/** A run parked on a prompt counts as busy for this long after it parked, and no longer (ADR 0007). */
export const PARKED_PROMPT_WINDOW_MS = 10 * 60_000;

/** How long a drain waits for running runs before it cuts them and the environment closes (ADR 0007). */
export const DRAIN_CAP_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// The run registry seam

/** One run as the registry reports it: its state, and the instants the idle rule reads. */
export type RunRecord =
  | { readonly id: string; readonly state: "starting" | "running"; readonly startedAt: Date }
  | { readonly id: string; readonly state: "parked"; readonly startedAt: Date; readonly parkedSince: Date }
  | { readonly id: string; readonly state: "ended"; readonly startedAt: Date; readonly endedAt: Date };

export type RunState = RunRecord["state"];

/**
 * What the lifecycle needs of the adapter host's runs. `runs` lists every run
 * not ended, and every run that ended within `IDLE_WINDOW_MS`; `onChange`
 * hears every change of state; `refuseNewRuns` is the drain's admission gate:
 * from then on a run the host is asked to start is refused with
 * `unavailable {readiness: draining}` before it starts.
 */
export interface RunRegistry {
  runs(): Iterable<RunRecord>;
  /** Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  refuseNewRuns(): void;
}

/**
 * The in-memory registry: the environment's preset, empty until the adapter
 * host (#119) records runs in it or brings its own, and the registry the
 * tests drive. Each change is stamped with the clock and heard by every
 * listener. An ended run is forgotten once it no longer counts.
 */
export interface MemoryRunRegistry extends RunRegistry {
  /** A new run, starting; refused with `unavailable` once the registry refuses new runs. */
  start(id: string): void;
  running(id: string): void;
  /** The run waits on a permission prompt or a question nobody has answered yet. */
  park(id: string): void;
  /** The prompt was answered and the run runs again. */
  resume(id: string): void;
  end(id: string): void;
}

/** The refusal of work the environment does not take while it drains. */
export const drainingRefusal = (what: string): ContractError =>
  new ContractError({ code: "unavailable", message: `The environment is draining and ${what}.`, data: { readiness: "draining" } });

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
    start(id) {
      if (refusing) throw drainingRefusal("starts no new runs");
      if (runs.has(id)) throw new Error(`A run ${id} is already in the registry.`);
      put({ id, state: "starting", startedAt: clock.now() });
    },
    running: (id) => put({ id, state: "running", startedAt: find(id).startedAt }),
    park: (id) => put({ id, state: "parked", startedAt: find(id).startedAt, parkedSince: clock.now() }),
    resume: (id) => put({ id, state: "running", startedAt: find(id).startedAt }),
    end: (id) => put({ id, state: "ended", startedAt: find(id).startedAt, endedAt: clock.now() }),
  };
};

// ---------------------------------------------------------------------------
// The idle rule

/** Idle or busy: the activity outside a drain. */
export type IdleOrBusy = Exclude<EnvironmentActivity, { state: "draining" }>;

/**
 * The idle rule (ADR 0007, the glossary's Idle), a pure function of the runs
 * and the time: busy while a run is starting or running; otherwise busy
 * until ten minutes after the latest start or end (`recent-activity`) or
 * after the latest parking of a run still parked (`parked-prompt`), with
 * `busyUntil` the later of them and the reason the one that holds longest
 * (a parked prompt on a tie); otherwise idle. A window ends at its instant:
 * ten minutes on, the run no longer counts.
 */
export const activityOf = (runs: Iterable<RunRecord>, now: Date): IdleOrBusy => {
  const at = now.getTime();
  let starting = false;
  let running = false;
  let until = -Infinity;
  let reason: "parked-prompt" | "recent-activity" | undefined;
  const hold = (instant: Date, windowMs: number, why: "parked-prompt" | "recent-activity"): void => {
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

/** The runs a drain waits for: those starting or running. A parked run survives the restart as an event (ADR 0007). */
const activeRuns = (registry: RunRegistry): string[] =>
  [...registry.runs()].filter((run) => run.state === "starting" || run.state === "running").map((run) => run.id);

// ---------------------------------------------------------------------------
// Container detection

/**
 * Whether the environment runs in a container, and whether a launcher spawned
 * it. In a container with no launcher its updates are managed outside: it
 * never updates itself, and a host-side updater recreates it (ADR 0007).
 */
export interface ContainerDetector {
  inContainer(): boolean;
  launcherPresent(): boolean;
}

/** What the default detector reads: files, and whether the process has an IPC channel. */
export interface ContainerProbe {
  exists(path: string): boolean;
  /** The file's text, or undefined when it cannot be read. */
  read(path: string): string | undefined;
  readonly hasIpc: boolean;
}

/** Files only a container runtime writes: Docker's, and Podman's. */
const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"] as const;
/** PID 1's cgroup path under a container runtime (cgroup v1, and v2 under Kubernetes). */
const CONTAINER_CGROUP = /docker|containerd|kubepods|libpod|lxc/;

const processProbe = (): ContainerProbe => ({
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  hasIpc: typeof process.send === "function",
});

/**
 * The preset detector: a container is one whose runtime left its marker file,
 * or whose PID 1 sits in a container runtime's cgroup; a launcher is present
 * when it spawned the environment with an IPC channel, which is what the
 * preset launcher channel speaks over. A heuristic: it reports only who
 * manages updates, and lifts no refusal.
 */
export const processContainerDetector = (probe: ContainerProbe = processProbe()): ContainerDetector => ({
  inContainer: () => CONTAINER_MARKERS.some((path) => probe.exists(path)) || CONTAINER_CGROUP.test(probe.read("/proc/1/cgroup") ?? ""),
  launcherPresent: () => probe.hasIpc,
});

// ---------------------------------------------------------------------------
// The lifecycle: status, drain, the launcher's queries, the methods

/** How a drain ended: every run it waited for finished, the cap cut the rest, or the environment was closed first. */
export interface DrainOutcome {
  readonly trigger: DrainTrigger;
  readonly drainingSince: string;
  readonly endedBy: "runs-finished" | "cap" | "closed";
  /** The runs still starting or running when the drain ended. */
  readonly cutRuns: readonly string[];
}

/** One drain: when and by what it began, and its end. A second trigger gets the same drain back. */
export interface Drain {
  readonly trigger: DrainTrigger;
  readonly drainingSince: string;
  readonly outcome: Promise<DrainOutcome>;
}

/** Who asked for a drain, recorded on its notice: a client session's `environment.drain` and its command id. */
export interface DrainCause {
  readonly actor?: string;
  readonly commandId?: string;
}

export interface LifecycleOptions {
  readonly clock: Clock;
  readonly runs: RunRegistry;
  readonly log: EventLog;
  /** The environment's own stream, where the draining notice goes. */
  readonly stream: StreamRef;
  readonly updatesManagedOutside: boolean;
  readonly readiness: () => EnvironmentReadiness;
  /** Called once, as a drain begins: readiness turns `draining`. */
  readonly onDraining: () => void;
  /** Closes the environment once the drain has waited: `bye: draining` to every socket, the listener, the log, the launcher channel. */
  readonly close: () => Promise<void>;
}

export interface Lifecycle {
  status(): EnvironmentStatus;
  /** Starts the drain, or joins the one under way. */
  drain(trigger: DrainTrigger, cause?: DrainCause): Drain;
  /** Settles when a drain has ended and the environment has closed; rejects if closing failed. */
  readonly drained: Promise<DrainOutcome>;
  /** The launcher's idle and drain queries. */
  answer(query: LauncherQuery): LauncherReply;
  /** The environment methods the lifecycle serves. */
  readonly methods: Required<
    Pick<MethodHandlers, "environment.status" | "environment.subscribe" | "environment.drain" | "environment.rebuildProjections">
  >;
  /** Stops a drain's wait, so it ends `closed`: the environment is closing. */
  close(): void;
}

const LIFECYCLE_ACTOR = formatActor({ kind: "system", id: "lifecycle" });

/**
 * The drain, one state machine: `drain` begins it once (readiness turns
 * `draining`, new runs are refused, the notice is appended), then waits
 * until no run is starting or running or the cap passes on the clock, then
 * closes the environment, whose wire says `bye: draining` to every socket.
 * Every later trigger joins it.
 */
export const createLifecycle = (options: LifecycleOptions): Lifecycle => {
  const { clock, runs, log } = options;
  let current: Drain | undefined;
  let closed = false;
  let stopWaiting: (() => void) | undefined;
  let settle!: { resolve: (outcome: DrainOutcome) => void; reject: (error: unknown) => void };
  const drained = new Promise<DrainOutcome>((resolve, reject) => (settle = { resolve, reject }));
  // Nothing need listen: a failure reaches whoever awaits it, never the process as an unhandled rejection.
  drained.catch(() => undefined);

  const activity = (): EnvironmentActivity =>
    current ? { state: "draining", drainingSince: current.drainingSince } : activityOf(runs.runs(), clock.now());
  const status = (): EnvironmentStatus => ({
    readiness: options.readiness(),
    activity: activity(),
    updatesManagedOutside: options.updatesManagedOutside,
  });

  /** Resolves once no run is starting or running, the cap passes, or the lifecycle is closed. */
  const waitForRuns = (): Promise<DrainOutcome["endedBy"]> =>
    new Promise((resolve) => {
      if (closed) return resolve("closed");
      let done = false;
      /** The cap's timer and the registry listener, let go when the wait ends. */
      const stops: (() => void)[] = [];
      const finish = (endedBy: DrainOutcome["endedBy"]): void => {
        if (done) return;
        done = true;
        for (const stop of stops) stop();
        stopWaiting = undefined;
        resolve(endedBy);
      };
      const check = (): void => {
        if (activeRuns(runs).length === 0) finish("runs-finished");
      };
      stopWaiting = () => finish("closed");
      const cap = clock.setTimeout(() => finish("cap"), DRAIN_CAP_MS);
      stops.push(() => cap.cancel(), runs.onChange(check));
      check();
    });

  const begin = (trigger: DrainTrigger, cause: DrainCause): Drain => {
    const drainingSince = clock.now().toISOString();
    let resolveOutcome!: (outcome: Promise<DrainOutcome>) => void;
    const outcome = new Promise<DrainOutcome>((resolve) => (resolveOutcome = resolve));
    outcome.catch(() => undefined);
    const drain: Drain = { trigger, drainingSince, outcome };
    current = drain;

    options.onDraining();
    runs.refuseNewRuns();
    if (!closed) {
      try {
        log.append(options.stream, [{ type: "environment.draining", payload: { drainingSince, trigger } }], {
          actor: cause.actor ?? LIFECYCLE_ACTOR,
          ...(cause.commandId !== undefined && { commandId: cause.commandId }),
        });
      } catch (error) {
        console.error("Appending the draining notice failed; the drain goes on:", error);
      }
    }

    resolveOutcome(
      (async () => {
        const endedBy = await waitForRuns();
        const ended: DrainOutcome = { trigger, drainingSince, endedBy, cutRuns: activeRuns(runs) };
        // One turn of the event loop first, so the answer to the request or query that started the drain leaves before its bye.
        await new Promise((resolve) => setImmediate(resolve));
        await options.close();
        return ended;
      })(),
    );
    outcome.then(settle.resolve, settle.reject);
    return drain;
  };

  const drain = (trigger: DrainTrigger, cause: DrainCause = {}): Drain => current ?? begin(trigger, cause);

  return {
    status,
    drain,
    drained,
    answer(query) {
      if (query.type === "drain") return { type: "draining", drainingSince: drain("launcher").drainingSince };
      const now = activity();
      return { type: "idle", idle: now.state === "idle", ...now };
    },
    methods: {
      "environment.status": status,
      // The subscription's snapshot, sent when replay from the cursor is out of bounds, is the status now.
      "environment.subscribe": () => ({ stream: options.stream, snapshot: () => ({ status: status() }) }),
      "environment.drain": ({ commandId }, { clientSession }) => {
        const joined = drain("command", { actor: formatActor({ kind: "client_session", id: clientSession.id }), commandId });
        return { drainingSince: joined.drainingSince, trigger: joined.trigger };
      },
      "environment.rebuildProjections": () => {
        const projectors = log.rebuildProjections();
        return { projectors: [...projectors], sequence: log.head() };
      },
    },
    close() {
      closed = true;
      stopWaiting?.();
    },
  };
};
