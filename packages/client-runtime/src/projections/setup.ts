import {
  DEFAULT_CADENCE_MINUTES,
  SETTINGS_ROWS,
  STEP_LABELS,
  STEP_ORDER,
  STEP_REGISTRY,
  type RegisteredStepId,
  type SettingsRowId,
  type StepId,
  type StepResult,
} from "@agent-harness/contracts";
import type { ConnectionPhase, ConnectionRecord } from "../connections/records.js";
import { derived, writable, type Observable } from "../observable.js";
import type { Clock, Timer } from "../platform.js";
import type { RequestAnswer, Requests } from "../requests.js";
import type { EnvironmentData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";

/**
 * `projections.setup(environmentId)` (the Set up specification, "Modules"
 * and "Results, the cache and the subscription"; ADR 0031; #570): the
 * eleven steps of the milestone-1 checklist in their order, each with its
 * label, its home row, whether the environment registers it and its latest
 * result, and the counts over the registered steps, which both renderers
 * draw Set up from (ADR 0004). `setup.check` goes through the request path
 * (`check`), and a step this client asked about reads pending once half a
 * second passes without the answer.
 */

/** How long this client's own check waits for its answer before its steps read pending (ADR 0031's half second). */
export const SETUP_PENDING_MS = 500;

/**
 * How often a result's age is counted again once it is older than its
 * step's cadence, while the projection is followed, so "checked 3 h ago"
 * stays true: a chosen default, the finest a renderer words an age in.
 */
export const SETUP_AGE_TICK_MS = 60_000;

/** One step's result as the projection shows it: the environment's result, its age, and whether it is stale. */
export interface SetupResultView extends StepResult {
  /**
   * How long ago it was checked, on the environment's clock as this client
   * reckons it, when the projection last computed: at each change, when a
   * result passes its step's cadence, and every `SETUP_AGE_TICK_MS` after.
   */
  readonly ageMs: number;
  /** Older than its step's cadence (ADR 0031): when a renderer shows its age. */
  readonly olderThanCadence: boolean;
  /**
   * Not known to hold now: the environment cannot be reached, or its stream
   * has not caught up since this client reached it (a result read from the
   * cursor cache after a restart). Kept with its checked-at meanwhile.
   */
  readonly stale: boolean;
}

/**
 * Whether this client can reach the environment, from the connection's
 * state (the Set up specification, "Running checks": unreachable is the
 * client's to see). A check cannot run on an environment the client cannot
 * reach, so its results are stale meanwhile. The local environment with its
 * service down offers `start-service`, which `connections.startService`
 * answers.
 */
export type SetupReach =
  | { readonly status: "reachable" }
  | {
      readonly status: "unreachable";
      /** The connection's phase; null for an environment this client has no connection to. */
      readonly phase: ConnectionPhase | null;
      /** Since when it has not been reached, on this client's clock; null while it never has and nothing is cached. */
      readonly since: string | null;
    }
  | { readonly status: "service-down"; readonly since: string | null; readonly action: "start-service" };

/** One of the eleven steps. */
export interface SetupStepView {
  readonly id: StepId;
  /** What every client names it (`STEP_LABELS`). */
  readonly label: string;
  /** The row of Settings it lives on (ADR 0027). */
  readonly home: SettingsRowId;
  /** Whether the environment registers it: it has given a result for it. */
  readonly registered: boolean;
  /** Its latest result; null for a step the environment has given none for. */
  readonly result: SetupResultView | null;
  /** This client asked `setup.check` about it half a second ago or more, and has had no answer yet. Never for a check this client did not ask. */
  readonly pending: boolean;
}

/** The registered steps by state, and the ones needing attention by id, in the checklist's order. */
export interface SetupCounts {
  readonly registered: number;
  readonly done: number;
  readonly needsAttention: number;
  readonly skipped: number;
  readonly attention: readonly StepId[];
}

export interface SetupView {
  readonly environmentId: string;
  readonly reach: SetupReach;
  /** The eleven steps, in the milestone-1 order. */
  readonly steps: readonly SetupStepView[];
  readonly counts: SetupCounts;
}

/** Each registered step's cadence, in milliseconds (ADR 0031); a step this build does not register has no result to age. */
const CADENCES_MS: ReadonlyMap<StepId, number> = new Map(STEP_REGISTRY.map((step) => [step.id, step.cadence.minutes * 60_000]));
const cadenceOf = (step: StepId): number => CADENCES_MS.get(step) ?? DEFAULT_CADENCE_MINUTES * 60_000;

/** When the view is next due to be computed again for its ages alone: a result passing its cadence, or the tick past it; null with no result. */
const nextAgeChange = (view: SetupView): number | null => {
  let soonest: number | null = null;
  for (const { result } of view.steps) {
    if (result === null) continue;
    const due = result.olderThanCadence ? SETUP_AGE_TICK_MS : cadenceOf(result.step) - result.ageMs + 1;
    if (soonest === null || due < soonest) soonest = due;
  }
  return soonest;
};

/** The row each step lives on, from the row registry (every step of the order has one, registered or not). */
const HOME_ROWS: ReadonlyMap<StepId, SettingsRowId> = new Map(
  SETTINGS_ROWS.flatMap((row) => (typeof row.homeOf === "string" ? [] : row.homeOf.map((step): [StepId, SettingsRowId] => [step, row.id]))),
);

export interface SetupHost {
  readonly clock: Clock;
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** Each environment's own stream, which carries its Set up results. */
  readonly environments: Observable<ReadonlyMap<string, StreamState<EnvironmentData>>>;
  /** The request path `setup.check` goes through. */
  readonly call: Requests["call"];
  /** The environment's time now, as this client reckons it from `hello`: what a result's age is counted against. */
  now(environmentId: string): Date;
}

export interface Setup {
  view(environmentId: string): Observable<SetupView>;
  /** `setup.check` of `step`, or of every step, through the request path: its steps pending after half a second, and each result it answers applied. */
  check(environmentId: string, step?: RegisteredStepId): Promise<RequestAnswer<"setup.check">>;
  /** The environment was removed: forget what its answers gave and what is being asked. */
  forget(environmentId: string): void;
  /** Lets go of every timer: the runtime closed. */
  close(): void;
}

/** One `setup.check` of this client's, until its answer or its failure. */
interface Ask {
  readonly environmentId: string;
  /** The step it names; every step when it names none. */
  readonly step: StepId | undefined;
  /** Half a second has passed. */
  due: boolean;
  timer: Timer | undefined;
}

const resultView = (result: StepResult, now: number, stale: boolean): SetupResultView => {
  const ageMs = Math.max(0, now - Date.parse(result.checkedAt));
  return { ...result, ageMs, olderThanCadence: ageMs > cadenceOf(result.step), stale };
};

const reachOf = (record: ConnectionRecord | undefined): SetupReach => {
  if (record === undefined) return { status: "unreachable", phase: null, since: null };
  if (record.phase === "ready" || record.phase === "syncing") return { status: "reachable" };
  if (record.action === "service.start") return { status: "service-down", since: record.unreachableSince, action: "start-service" };
  return { status: "unreachable", phase: record.phase, since: record.unreachableSince };
};

const countsOf = (steps: readonly SetupStepView[]): SetupCounts => {
  const results = steps.flatMap((step) => (step.result === null ? [] : [step.result]));
  const attention = results.filter((result) => result.state === "needs-attention").map((result) => result.step);
  return {
    registered: results.length,
    done: results.filter((result) => result.state === "done").length,
    needsAttention: attention.length,
    skipped: results.filter((result) => result.state === "skipped").length,
    attention,
  };
};

/**
 * The later of the stream's result and an answer's for one step, by when
 * each check ran, as the environment's cache keeps the check that started
 * last; the stream's on a tie, since it is the cache's.
 */
const latest = (streamed: StepResult | undefined, answered: StepResult | undefined): { readonly result: StepResult; readonly answered: boolean } | undefined => {
  if (answered !== undefined && (streamed === undefined || Date.parse(answered.checkedAt) > Date.parse(streamed.checkedAt))) return { result: answered, answered: true };
  return streamed === undefined ? undefined : { result: streamed, answered: false };
};

export const createSetup = (host: SetupHost): Setup => {
  /** What this client's own checks answered, by environment and step: kept beside the stream's, since a result that only refreshes its checked-at is never noticed. */
  const answers = new Map<string, Map<StepId, StepResult>>();
  const asks = new Set<Ask>();
  /** Moves whenever an answer is applied or an ask changes, so the views recompute. */
  const version = writable(0);
  const changed = () => version.update((n) => n + 1);

  const views = new Map<string, Observable<SetupView>>();
  /** Each view's timer for its next change of age. */
  const wakes = new Map<string, Timer>();
  const compute = (environmentId: string, records: readonly ConnectionRecord[], environments: ReadonlyMap<string, StreamState<EnvironmentData>>): SetupView => {
    const reach = reachOf(records.find((record) => record.environmentId === environmentId));
    const stream = environments.get(environmentId);
    const streamed = new Map((stream?.data?.setup ?? []).map((result) => [result.step as StepId, result]));
    const answered = answers.get(environmentId);
    const live = stream?.freshness === "live";
    const reachable = reach.status === "reachable";
    const now = host.now(environmentId).getTime();
    const asking = [...asks].filter((ask) => ask.environmentId === environmentId && ask.due);
    const steps = STEP_ORDER.map((id): SetupStepView => {
      const held = latest(streamed.get(id), answered?.get(id));
      return {
        id,
        label: STEP_LABELS[id],
        home: HOME_ROWS.get(id) as SettingsRowId,
        registered: held !== undefined,
        // An answer is as fresh as the stream while the environment can be reached; the stream's results, once it is live.
        result: held === undefined ? null : resultView(held.result, now, !reachable || (!held.answered && !live)),
        pending: asking.some((ask) => ask.step === undefined || ask.step === id),
      };
    });
    return { environmentId, reach, steps, counts: countsOf(steps) };
  };

  /**
   * The view of one environment, which asks `setup.check` of every step each
   * time it comes to be followed, on an environment without the `setup`
   * flag: at once when the connection is ready, else once it is while still
   * followed. One with the flag is never asked: its stream carries its
   * results (the Set up specification, "Capability flags").
   */
  const followed = (environmentId: string): Observable<SetupView> => {
    // Moved when an age is due to change: a result passing its cadence, or the tick past it.
    const ages = writable(0);
    const inner = derived([host.records, host.environments, version, ages] as const, (records, environments) => {
      const view = compute(environmentId, records, environments);
      wakes.get(environmentId)?.cancel();
      const due = nextAgeChange(view);
      if (due === null) wakes.delete(environmentId);
      else wakes.set(environmentId, host.clock.setTimeout(() => ages.update((n) => n + 1), due));
      return view;
    });
    let followers = 0;
    let waiting: (() => void) | undefined;
    const askWhenReady = (records: readonly ConnectionRecord[]) => {
      const record = records.find((r) => r.environmentId === environmentId);
      if (record?.phase !== "ready") return;
      waiting?.();
      waiting = undefined;
      if (!record.descriptor.capabilities.includes("setup")) void setup.check(environmentId);
    };
    return {
      read: inner.read,
      subscribe(listener) {
        const stop = inner.subscribe(listener);
        if (++followers === 1) {
          waiting = host.records.subscribe(askWhenReady);
          askWhenReady(host.records.read());
        }
        let following = true;
        return () => {
          if (!following) return;
          following = false;
          stop();
          if (--followers > 0) return;
          waiting?.();
          waiting = undefined;
        };
      },
    };
  };

  const setup: Setup = {
    view(environmentId) {
      let view = views.get(environmentId);
      if (view === undefined) views.set(environmentId, (view = followed(environmentId)));
      return view;
    },
    async check(environmentId, step) {
      const ask: Ask = { environmentId, step, due: false, timer: undefined };
      ask.timer = host.clock.setTimeout(() => {
        ask.timer = undefined;
        ask.due = true;
        changed();
      }, SETUP_PENDING_MS);
      asks.add(ask);
      const answer = await host.call(environmentId, "setup.check", step === undefined ? {} : { step });
      ask.timer?.cancel();
      // An ask its environment's removal (or the runtime's close) let go of applies nothing.
      if (!asks.delete(ask)) return answer;
      if (answer.ok) {
        let held = answers.get(environmentId);
        if (held === undefined) answers.set(environmentId, (held = new Map()));
        for (const result of answer.result.results) {
          const before = held.get(result.step);
          if (before === undefined || Date.parse(result.checkedAt) >= Date.parse(before.checkedAt)) held.set(result.step, result);
        }
      }
      // A failure within the half second changes nothing shown.
      if (answer.ok || ask.due) changed();
      return answer;
    },
    forget(environmentId) {
      answers.delete(environmentId);
      views.delete(environmentId);
      wakes.get(environmentId)?.cancel();
      wakes.delete(environmentId);
      for (const ask of asks) {
        if (ask.environmentId !== environmentId) continue;
        ask.timer?.cancel();
        asks.delete(ask);
      }
      changed();
    },
    close() {
      for (const ask of asks) ask.timer?.cancel();
      asks.clear();
      for (const wake of wakes.values()) wake.cancel();
      wakes.clear();
    },
  };
  return setup;
};
