import { isDeepStrictEqual } from "node:util";
import { StepResult, type LastGood, type RegisteredStepId, type SettingsValues } from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import { checkStep, type CheckedStep, type StateChecker } from "./check.js";

/**
 * The SetupService (the Set up specification, "Modules" and "Results, the
 * cache and the subscription"; ADR 0031; #141, #308, #569): runs a
 * registered step's health check on this environment now, or every
 * registered step's at once, reading the settings as they are and asking
 * the state checks the environment was started with, and answers once each
 * step has answered or run out of its budget, in the registry's order. It
 * keeps each step's last good result since the start, for a result that
 * timed out or could not check to carry.
 *
 * Each result is kept in the result cache (`result-table.ts`), one row per
 * step beside the event log, which survives a restart with its checked-at
 * and which no check reads; `cached` reads it back for
 * `environment.subscribe`'s snapshot. A step's first result, and one that
 * differs from the cached one in anything but its checked-at, appends
 * `setup.result-changed` with the result on the environment stream, as
 * `system:setup` and in the transaction that writes the row; one that only
 * refreshes its checked-at updates the row and appends nothing. The cache
 * holds the latest check's result: one from a check that started before
 * the one whose result the cache holds, and answered after it, is answered
 * to its caller and kept nowhere.
 *
 * Not built here, and the Set up specification's (#571): the runs on
 * start, on a feature's events and on each step's cadence.
 */

/** Who appends `setup.result-changed`: Set up itself, whoever asked for the check. */
export const SETUP_ACTOR = formatActor({ kind: "system", id: "setup" });

/** The steps the service checks, in order, and how the environment answers their state checks, by id. */
export interface SetupSteps {
  readonly steps: readonly CheckedStep[];
  readonly stateChecks: { readonly [id: string]: StateChecker };
}

export interface SetupServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's own presets, where they differ from the key table's (the containment default, #133). */
  readonly presets: Partial<SettingsValues>;
  /** The step registry with this environment's answers to its state checks, or a test's own steps. */
  readonly steps: SetupSteps;
  /** The environment stream, which a changed result's notice goes on. */
  readonly stream: StreamRef;
}

export interface SetupService {
  /** Checks `step` now, or every registered step when none is named; answers the results in the registry's order, each kept in the cache first. */
  check(step?: RegisteredStepId): Promise<StepResult[]>;
  /** Every registered step's cached result, in the registry's order: a step never checked, or whose row this build cannot read, is absent. */
  cached(): StepResult[];
}

/** A cached row's result, or undefined for none, or one this build cannot read (a row another version wrote). */
const readResult = (json: string | undefined): StepResult | undefined => {
  if (json === undefined) return undefined;
  try {
    const parsed = StepResult.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** Whether two results of a step differ in nothing but when they were checked. */
const sameButCheckedAt = (a: StepResult, b: StepResult): boolean => isDeepStrictEqual({ ...a, checkedAt: "" }, { ...b, checkedAt: "" });

export const createSetupService = (options: SetupServiceOptions): SetupService => {
  const { log, clock, steps, stream } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const lastGood = new Map<RegisteredStepId, LastGood>();
  /** How many checks have started since the environment did: each check's number is its place in that order. */
  let started = 0;
  /** The number of the check whose result each step's row holds, for rows written since the start. */
  const keptFrom = new Map<RegisteredStepId, number>();

  /** Writes `result` to its step's row, and appends its notice when it changed, unless a later check's result is there. */
  const keep = (result: StepResult, check: number): void => {
    if ((keptFrom.get(result.step) ?? 0) > check) return;
    keptFrom.set(result.step, check);
    log.atomically((tx) => {
      const cached = readResult(log.setupResults.read(result.step));
      log.setupResults.write(tx, result.step, JSON.stringify(result));
      if (cached !== undefined && sameButCheckedAt(cached, result)) return;
      log.append(stream, [{ type: "setup.result-changed", payload: result }], { actor: SETUP_ACTOR, tx });
    });
  };

  const run = async (step: CheckedStep, values: SettingsValues, checkedAt: string, check: number): Promise<StepResult> => {
    const result = await checkStep(step, { values, stateChecks: steps.stateChecks, clock, checkedAt, lastGood: lastGood.get(step.id) });
    if (result.state !== "needs-attention") lastGood.set(step.id, { state: result.state, reason: result.reason, checkedAt: result.checkedAt });
    keep(result, check);
    return result;
  };

  return {
    check(id) {
      const values = readSettings(reader, options.presets);
      const checkedAt = clock.now().toISOString();
      const check = ++started;
      return Promise.all(steps.steps.filter((entry) => id === undefined || entry.id === id).map((entry) => run(entry, values, checkedAt, check)));
    },
    cached() {
      const rows = new Map(log.setupResults.all().map((row) => [row.step, row.result]));
      return steps.steps.flatMap((entry) => readResult(rows.get(entry.id)) ?? []);
    },
  };
};
