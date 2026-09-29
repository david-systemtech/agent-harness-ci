import { SETTINGS_ROWS, STEP_LABELS, STEP_ORDER, type RegisteredStepId, type SettingsRowId, type StepId, type StepResult } from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
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

/** One step's result as the projection shows it: the environment's result, and whether it is stale. */
export interface SetupResultView extends StepResult {
  /** Held from before this client last reached the environment: the cache's, kept with its checked-at while it cannot be reached. */
  readonly stale: boolean;
}

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
  /** The eleven steps, in the milestone-1 order. */
  readonly steps: readonly SetupStepView[];
  readonly counts: SetupCounts;
}

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
  const compute = (environmentId: string, environments: ReadonlyMap<string, StreamState<EnvironmentData>>): SetupView => {
    const stream = environments.get(environmentId);
    const streamed = new Map((stream?.data?.setup ?? []).map((result) => [result.step as StepId, result]));
    const answered = answers.get(environmentId);
    const live = stream?.freshness === "live";
    const asking = [...asks].filter((ask) => ask.environmentId === environmentId && ask.due);
    const steps = STEP_ORDER.map((id): SetupStepView => {
      const held = latest(streamed.get(id), answered?.get(id));
      return {
        id,
        label: STEP_LABELS[id],
        home: HOME_ROWS.get(id) as SettingsRowId,
        registered: held !== undefined,
        result: held === undefined ? null : { ...held.result, stale: !held.answered && !live },
        pending: asking.some((ask) => ask.step === undefined || ask.step === id),
      };
    });
    return { environmentId, steps, counts: countsOf(steps) };
  };

  return {
    view(environmentId) {
      let view = views.get(environmentId);
      if (view === undefined) views.set(environmentId, (view = derived([host.environments, version] as const, (environments) => compute(environmentId, environments))));
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
    },
  };
};
