import {
  CHECK_BUDGET_SECONDS,
  DEFAULT_CADENCE_MINUTES,
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
import { REQUEST_TIMEOUT_MS, canonical, type RequestAnswer, type Requests } from "../requests.js";
import type { EnvironmentData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";
import { stepHome } from "../settings/rows.js";

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
 * How long this client's own check waits for its answer: the longest check
 * budget (a git probe's thirty seconds), past which the environment
 * answers that the check timed out, then the request path's own
 * `REQUEST_TIMEOUT_MS` for the rest of the round trip. A chosen default:
 * the request path's thirty seconds alone would give up on a check the
 * environment is about to answer.
 */
export const SETUP_CHECK_TIMEOUT_MS = CHECK_BUDGET_SECONDS.git * 1000 + REQUEST_TIMEOUT_MS;

/**
 * How often an asked result's age is counted again once it is older than
 * its step's cadence, while the projection is followed, so "checked 3 h ago"
 * stays true: a chosen default, the finest a renderer words an age in.
 */
export const SETUP_AGE_TICK_MS = 60_000;

/** One step's result as the projection shows it: the environment's result, how this client knows it, its age, and whether it is stale. */
export interface SetupResultView extends StepResult {
  /**
   * The answer to this client's own `setup.check`, whose checked-at is when
   * the environment last checked the step; false for a result this client
   * follows, whose checked-at is only when it last heard of a check (#671).
   * A check that finds nothing new appends no notice, so a followed result
   * is said to be unchanged since its checked-at, never aged: the stream's
   * result, and an answer of its own once the step's cadence has passed on
   * an environment whose stream carries Set up, which has checked it again
   * unasked by then. Without the `setup` flag nothing is followed, so an
   * answer stays asked.
   */
  readonly asked: boolean;
  /**
   * How long ago its checked-at was, on the environment's clock as this
   * client reckons it, when the projection last computed: at each change,
   * when an asked result passes its step's cadence, and every
   * `SETUP_AGE_TICK_MS` after.
   */
  readonly ageMs: number;
  /** An asked result older than its step's cadence (ADR 0031): when a renderer shows its age. Never a followed one (#671). */
  readonly olderThanCadence: boolean;
  /**
   * Not known to hold now: the environment cannot be reached, or, for a
   * followed result, its stream has not caught up since this client reached
   * it (a result read from the cursor cache after a restart). Kept with its
   * checked-at meanwhile.
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
  /**
   * Whether it may be skipped (the step registry's `skippable`), for the
   * first launch's Skip for now: false for a step this build's registry
   * lacks, whose rule it cannot know.
   */
  readonly skippable: boolean;
  /** Its latest result; null for a step the environment has given none for. */
  readonly result: SetupResultView | null;
  /** This client asked `setup.check` about it half a second ago or more, and has had no answer yet. Never for a check this client did not ask. */
  readonly pending: boolean;
  /**
   * The environment's version does not have it: this client's latest
   * `setup.check` of every step was answered without it, and it has no
   * result. Never while no such answer has come, so a result still on its
   * way is not missing.
   */
  readonly missing: boolean;
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

/**
 * Each registered step's cadence, in milliseconds (ADR 0031). A result of a
 * step this build does not register, which a newer environment gives
 * (#672), ages against the hour a step has unless its entry gives another.
 */
const CADENCES_MS: ReadonlyMap<StepId, number> = new Map(STEP_REGISTRY.map((step) => [step.id, step.cadence.minutes * 60_000]));
const cadenceOf = (step: StepId): number => CADENCES_MS.get(step) ?? DEFAULT_CADENCE_MINUTES * 60_000;

/**
 * When the view is next due to be computed again for its ages alone: an
 * asked result passing its cadence, or the tick past it; the tick for a
 * result whose reason names a past time, whose age its line says (#1742);
 * null with none. A followed result's line names its checked-at, which time
 * does not change.
 */
const nextAgeChange = (view: SetupView): number | null => {
  let soonest: number | null = null;
  for (const { result } of view.steps) {
    if (result === null) continue;
    const due = result.times !== undefined ? SETUP_AGE_TICK_MS : !result.asked ? null : result.olderThanCadence ? SETUP_AGE_TICK_MS : cadenceOf(result.step) - result.ageMs + 1;
    if (due !== null && (soonest === null || due < soonest)) soonest = due;
  }
  return soonest;
};

/** The steps this build's registry lets be skipped. */
const SKIPPABLE: ReadonlySet<StepId> = new Set(STEP_REGISTRY.filter((step) => step.skippable).map((step) => step.id));

export interface SetupHost {
  readonly clock: Clock;
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** Each environment's own stream, which carries its Set up results. */
  readonly environments: Observable<ReadonlyMap<string, StreamState<EnvironmentData>>>;
  /** The request path `setup.check` goes through, waiting `SETUP_CHECK_TIMEOUT_MS` for its answer. */
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

/** A step's result as this client holds it, and whether an answer to its own check gave it. */
interface Held {
  readonly result: StepResult;
  readonly answered: boolean;
}

/** What the environment's stream gives the view now: whether it can be reached, whether its stream is live, and whether that stream carries Set up. */
interface Hearing {
  readonly reachable: boolean;
  readonly live: boolean;
  readonly follows: boolean;
}

/** One step's result as the view shows it: an answer of this client's own reads asked until its cadence passes on an environment that carries Set up (#671). */
const resultView = ({ result, answered }: Held, now: number, { reachable, live, follows }: Hearing): SetupResultView => {
  const ageMs = Math.max(0, now - Date.parse(result.checkedAt));
  const older = ageMs > cadenceOf(result.step);
  const asked = answered && !(follows && older);
  // An answer is as fresh as the stream while the environment can be reached; a followed result, once the stream is live.
  return { ...result, asked, ageMs, olderThanCadence: asked && older, stale: !reachable || (!asked && !live) };
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
 * last; the stream's on a tie, since it is the cache's. The stream's result
 * is still the one this client asked for when its answer carried that very
 * result, checked-at included: a check of its own that changed the result is
 * noticed too (#671).
 */
const latest = (streamed: StepResult | undefined, answered: StepResult | undefined): Held | undefined => {
  if (answered !== undefined && (streamed === undefined || Date.parse(answered.checkedAt) > Date.parse(streamed.checkedAt))) return { result: answered, answered: true };
  return streamed === undefined ? undefined : { result: streamed, answered: answered !== undefined && canonical(answered) === canonical(streamed) };
};

export const createSetup = (host: SetupHost): Setup => {
  /** What this client's own checks answered, by environment and step: kept beside the stream's, since a result that only refreshes its checked-at is never noticed. */
  const answers = new Map<string, Map<StepId, StepResult>>();
  const asks = new Set<Ask>();
  /** The steps the latest answer to a check of every step gave a result for, by environment: every step it registers. */
  const covered = new Map<string, ReadonlySet<string>>();
  /** Moves whenever an answer is applied or an ask changes, so the views recompute. */
  const version = writable(0);
  const changed = () => version.update((n) => n + 1);

  const views = new Map<string, Observable<SetupView>>();
  /** Each view's timer for its next change of age. */
  const wakes = new Map<string, Timer>();
  let closed = false;
  const compute = (environmentId: string, records: readonly ConnectionRecord[], environments: ReadonlyMap<string, StreamState<EnvironmentData>>): SetupView => {
    const record = records.find((r) => r.environmentId === environmentId);
    const reach = reachOf(record);
    const stream = environments.get(environmentId);
    const streamed = new Map((stream?.data?.setup ?? []).map((result) => [result.step, result]));
    const answered = answers.get(environmentId);
    const hearing: Hearing = {
      reachable: reach.status === "reachable",
      live: stream?.freshness === "live",
      follows: record?.descriptor.capabilities.includes("setup") === true,
    };
    const now = host.now(environmentId).getTime();
    const asking = [...asks].filter((ask) => ask.environmentId === environmentId && ask.due);
    const registers = covered.get(environmentId);
    const steps = STEP_ORDER.map((id): SetupStepView => {
      const held = latest(streamed.get(id), answered?.get(id));
      return {
        id,
        label: STEP_LABELS[id],
        home: stepHome(id),
        registered: held !== undefined,
        skippable: SKIPPABLE.has(id),
        result: held === undefined ? null : resultView(held, now, hearing),
        pending: asking.some((ask) => ask.step === undefined || ask.step === id),
        missing: held === undefined && registers !== undefined && !registers.has(id),
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
  const viewOf = (environmentId: string): Observable<SetupView> => {
    // Moved when an age is due to change: a result passing its cadence, or the tick past it.
    const ages = writable(0);
    const inner = derived([host.records, host.environments, version, ages] as const, (records, environments) => {
      const view = compute(environmentId, records, environments);
      wakes.get(environmentId)?.cancel();
      wakes.delete(environmentId);
      const due = closed ? null : nextAgeChange(view);
      if (due !== null) wakes.set(environmentId, host.clock.setTimeout(() => ages.update((n) => n + 1), due));
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
      if (view === undefined) views.set(environmentId, (view = viewOf(environmentId)));
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
        if (step === undefined) covered.set(environmentId, new Set(answer.result.results.map((result) => result.step)));
      }
      // A failure within the half second changes nothing shown.
      if (answer.ok || ask.due) changed();
      return answer;
    },
    forget(environmentId) {
      answers.delete(environmentId);
      covered.delete(environmentId);
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
      closed = true;
      for (const ask of asks) ask.timer?.cancel();
      asks.clear();
      for (const wake of wakes.values()) wake.cancel();
      wakes.clear();
    },
  };
  return setup;
};
