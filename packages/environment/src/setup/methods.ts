import type { LastGood, RegisteredStepId, SettingsValues } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import { checkStep, type CheckedStep, type StateChecker } from "./check.js";

/**
 * `setup.check` (ADR 0031; #141, #308): runs a registered step's health
 * check on this environment now, or every registered step's at once,
 * reading the settings as they are and asking the state checks the
 * environment was started with; it answers once each step has answered or
 * run out of its budget, in the registry's order. It writes nothing. It
 * keeps each step's last good result since the start, for a result that
 * timed out or could not check to carry. Not built here, and the Set up
 * specification's (#88): the `setup` subscription carrying the latest
 * results, their cache across a restart, and the runs on start, on a
 * feature's events and on each step's cadence.
 */

/** The steps `setup.check` runs, in order, and how the environment answers their state checks, by id. */
export interface SetupSteps {
  readonly steps: readonly CheckedStep[];
  readonly stateChecks: { readonly [id: string]: StateChecker };
}

export interface SetupMethodsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's own presets, where they differ from the key table's (the containment default, #133). */
  readonly presets: Partial<SettingsValues>;
  /** The step registry with this environment's answers to its state checks, or a test's own steps. */
  readonly steps: SetupSteps;
}

export const setupMethods = (options: SetupMethodsOptions): Required<Pick<MethodHandlers, "setup.check">> => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  const lastGood = new Map<RegisteredStepId, LastGood>();

  const check = async (step: CheckedStep, values: SettingsValues, checkedAt: string) => {
    const result = await checkStep(step, { values, stateChecks: options.steps.stateChecks, clock: options.clock, checkedAt, lastGood: lastGood.get(step.id) });
    if (result.state !== "needs-attention") lastGood.set(step.id, { state: result.state, reason: result.reason, checkedAt: result.checkedAt });
    return result;
  };

  return {
    "setup.check": async ({ step }) => {
      const values = readSettings(reader, options.presets);
      const checkedAt = options.clock.now().toISOString();
      const steps = options.steps.steps.filter((entry) => step === undefined || entry.id === step);
      return { results: await Promise.all(steps.map((entry) => check(entry, values, checkedAt))) };
    },
  };
};
