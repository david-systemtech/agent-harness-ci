import type {
  DrainStarted,
  DrainTrigger,
  EnvironmentActivity,
  EnvironmentReadiness,
  EnvironmentStatus,
  LauncherQuery,
  LauncherReply,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { StreamSource } from "../wire/subscriptions.js";
import type { Clock } from "./clock.js";
import type { MethodHandlers } from "./methods.js";
import { activityOf, type RunRegistry } from "./run-registry.js";

/**
 * The environment's lifecycle (env spec, "Lifecycle"; ADR 0007): the status
 * document (readiness, idle or busy or draining, who manages updates) and the
 * drain. Runs are read through the run registry (`run-registry.ts`).
 */

/** How long a drain waits for running runs before it cuts them and the environment closes (ADR 0007). */
export const DRAIN_CAP_MS = 30 * 60_000;

/**
 * How a drain ended: every run it waited for finished, the cap cut the rest,
 * or the environment was closed first. Not on the wire: the adapter host
 * marks cut runs in the log, ending each `drained` as the environment closes.
 */
export interface DrainOutcome extends DrainStarted {
  readonly endedBy: "runs-finished" | "cap" | "closed";
  /** The runs still starting or running when the drain ended. */
  readonly cutRuns: readonly string[];
}

/** One drain: how it began, and its end. A second trigger gets the same drain back. */
export interface Drain extends DrainStarted {
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
  /** The idle window, in milliseconds, read each time the activity is: the environment's `updates.idleWindowMinutes`. */
  readonly idleWindowMs: () => number;
  /** Whether a terminal's shell runs a command in its foreground, read each time the activity is: busy as a run is (#343). */
  readonly terminalRunning: () => boolean;
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
  /** The lifecycle's own methods. */
  readonly handlers: Required<Pick<MethodHandlers, "environment.status" | "environment.drain">>;
  /** What `environment.subscribe` reads: the environment's notices, snapshotted as the status. */
  readonly source: StreamSource<{ status: EnvironmentStatus }>;
  /** Ends a drain's wait at once: the environment is closing. */
  stopWaiting(): void;
}

/** The runs a drain waits for: those starting or running. A parked run survives the restart as an event (ADR 0007). */
const activeRuns = (registry: RunRegistry): string[] =>
  [...registry.runs()].filter((run) => run.state === "starting" || run.state === "running").map((run) => run.id);

const LIFECYCLE_ACTOR = formatActor({ kind: "system", id: "lifecycle" });

/**
 * The drain, one state machine: `drain` begins it once (readiness turns
 * `draining`, the registry refuses new runs, the notice is appended), then
 * waits until no run is starting or running or the cap passes on the clock,
 * then takes one turn on the clock, so the answer to what started it leaves
 * first, then closes the environment, whose wire says `bye: draining` to
 * every socket. Every later trigger joins it.
 */
export const createLifecycle = (options: LifecycleOptions): Lifecycle => {
  const { clock, runs, log } = options;
  let current: Drain | undefined;
  let stopped = false;
  let interrupt: (() => void) | undefined;
  let settle!: { resolve: (outcome: DrainOutcome) => void; reject: (error: unknown) => void };
  const drained = new Promise<DrainOutcome>((resolve, reject) => (settle = { resolve, reject }));
  // Nothing need listen: a failure reaches whoever awaits it, never the process as an unhandled rejection.
  drained.catch(() => undefined);

  const activity = (): EnvironmentActivity =>
    current
      ? { state: "draining", drainingSince: current.drainingSince }
      : activityOf(runs.runs(), clock.now(), options.idleWindowMs(), options.terminalRunning());
  const status = (): EnvironmentStatus => ({
    readiness: options.readiness(),
    activity: activity(),
    updatesManagedOutside: options.updatesManagedOutside,
  });

  /**
   * Resolves once no run is starting or running, or the cap passes, and one
   * turn on the clock after; at once, `closed`, when the wait is stopped.
   */
  const waitForRuns = (): Promise<DrainOutcome["endedBy"]> =>
    new Promise((resolve) => {
      if (stopped) return resolve("closed");
      let waiting = true;
      let ended = false;
      /** The timers and the registry listener, let go when the wait ends. */
      const stops: (() => void)[] = [];
      const end = (endedBy: DrainOutcome["endedBy"]): void => {
        if (ended) return;
        ended = true;
        for (const stop of stops) stop();
        interrupt = undefined;
        resolve(endedBy);
      };
      const finish = (endedBy: DrainOutcome["endedBy"]): void => {
        if (!waiting) return;
        waiting = false;
        const turn = clock.setTimeout(() => end(endedBy), 0);
        stops.push(() => turn.cancel());
        interrupt = () => end(endedBy);
      };
      const check = (): void => {
        if (activeRuns(runs).length === 0) finish("runs-finished");
      };
      interrupt = () => end("closed");
      const cap = clock.setTimeout(() => finish("cap"), DRAIN_CAP_MS);
      stops.push(() => cap.cancel(), runs.onChange(check));
      check();
    });

  const begin = (trigger: DrainTrigger, cause: DrainCause): Drain => {
    const started: DrainStarted = { drainingSince: clock.now().toISOString(), trigger };
    let resolveOutcome!: (outcome: Promise<DrainOutcome>) => void;
    const outcome = new Promise<DrainOutcome>((resolve) => (resolveOutcome = resolve));
    outcome.catch(() => undefined);
    const drain: Drain = { ...started, outcome };
    current = drain;

    options.onDraining();
    runs.refuseNewRuns();
    if (!stopped) {
      try {
        log.append(options.stream, [{ type: "environment.draining", payload: { ...started } }], {
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
        const ended: DrainOutcome = { ...started, endedBy, cutRuns: activeRuns(runs) };
        await options.close();
        return ended;
      })(),
    );
    outcome.then(settle.resolve, settle.reject);
    return drain;
  };

  const drain = (trigger: DrainTrigger, cause: DrainCause = {}): Drain => current ?? begin(trigger, cause);
  const startedOf = ({ drainingSince, trigger }: Drain): DrainStarted => ({ drainingSince, trigger });

  return {
    status,
    drain,
    drained,
    answer: (query) =>
      query.type === "drain?" ? { type: "draining", ...startedOf(drain("launcher")) } : { type: "idle", ...status() },
    handlers: {
      "environment.status": status,
      // The notice joins the command's transaction; a drain it joins appends nothing, so its receipt says unchanged.
      "environment.drain": (_params, { actor, commandId }) => ({
        aggregate: options.stream,
        result: startedOf(drain("command", { actor, commandId })),
      }),
    },
    // The snapshot, sent when replay from the cursor is out of bounds, is the status now.
    source: { stream: options.stream, snapshot: () => ({ status: status() }) },
    stopWaiting() {
      stopped = true;
      interrupt?.();
    },
  };
};
