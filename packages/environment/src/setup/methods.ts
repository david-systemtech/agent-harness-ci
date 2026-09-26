import { STEP_REGISTRY, type SettingsValues } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import { checkStep, type StateCheckers } from "./check.js";

/**
 * `setup.check` (ADR 0031; #141): runs a registered step's health check on
 * this environment now, or every registered step's in the milestone-1
 * order, reading the settings as they are and asking the state checks the
 * environment was started with. It writes nothing. Not built here, and the
 * Set up specification's (#88): the `setup` subscription carrying the latest
 * results, their cache across a restart, the runs on start, on a feature's
 * events and hourly, and each check's budget.
 */

export interface SetupMethodsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's own presets, where they differ from the key table's (the containment default, #133). */
  readonly presets: Partial<SettingsValues>;
  /** How the environment answers each state check the registry names. */
  readonly stateChecks: StateCheckers;
}

export const setupMethods = (options: SetupMethodsOptions): Required<Pick<MethodHandlers, "setup.check">> => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  return {
    "setup.check": ({ step }) => {
      const values = readSettings(reader, options.presets);
      const checkedAt = options.clock.now().toISOString();
      const steps = STEP_REGISTRY.filter((entry) => step === undefined || entry.id === step);
      return { results: steps.map((entry) => checkStep(entry, values, options.stateChecks, checkedAt)) };
    },
  };
};
