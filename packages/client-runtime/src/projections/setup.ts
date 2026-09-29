import { SETTINGS_ROWS, STEP_LABELS, STEP_ORDER, type SettingsRowId, type StepId, type StepResult } from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
import { derived, type Observable } from "../observable.js";
import type { EnvironmentData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";

/**
 * `projections.setup(environmentId)` (the Set up specification, "Modules"
 * and "Results, the cache and the subscription"; ADR 0031; #570): the
 * eleven steps of the milestone-1 checklist in their order, each with its
 * label, its home row, whether the environment registers it and its latest
 * result, and the counts over the registered steps, which both renderers
 * draw Set up from (ADR 0004).
 */

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
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** Each environment's own stream, which carries its Set up results. */
  readonly environments: Observable<ReadonlyMap<string, StreamState<EnvironmentData>>>;
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

export const setupProjection = (host: SetupHost, environmentId: string): Observable<SetupView> =>
  derived([host.environments] as const, (environments): SetupView => {
    const stream = environments.get(environmentId);
    const held = new Map((stream?.data?.setup ?? []).map((result) => [result.step as StepId, result]));
    const stale = stream?.freshness !== "live";
    const steps = STEP_ORDER.map((id): SetupStepView => {
      const result = held.get(id);
      return {
        id,
        label: STEP_LABELS[id],
        home: HOME_ROWS.get(id) as SettingsRowId,
        registered: result !== undefined,
        result: result === undefined ? null : { ...result, stale },
      };
    });
    return { environmentId, steps, counts: countsOf(steps) };
  });
