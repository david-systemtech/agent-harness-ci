import { StepResult, type StepId } from "@agent-harness/contracts";
import { MANUAL_CLOCK_START } from "../src/testing/in-memory-platform.js";

/**
 * Set up step results as an environment answers and publishes them (the Set
 * up specification, "Results, the cache and the subscription"), for the
 * suites of `projections.setup` (#570). Each is parsed by the contracts'
 * `StepResult`, so a fixture that drifts from the wire fails where it is made.
 */

/** A done result of `step`, checked at the manual clock's start; `fields` replace any of its own. */
export const doneResult = (step: StepId, fields: Partial<StepResult> = {}): StepResult =>
  StepResult.parse({ step, state: "done", reason: `${step} holds.`, failing: [], actions: [], checkedAt: MANUAL_CLOCK_START, ...fields });

/** A result of `step` that needs attention for the state check `failing`, offering `actions`; `fields` replace any of its own. */
export const attentionResult = (step: StepId, failing: string, actions: StepResult["actions"], fields: Partial<StepResult> = {}): StepResult =>
  StepResult.parse({ step, state: "needs-attention", reason: `${failing} does not hold.`, failing: [failing], actions, checkedAt: MANUAL_CLOCK_START, ...fields });

/** A skipped result of `step`: nothing is set up there to check. */
export const skippedResult = (step: StepId, fields: Partial<StepResult> = {}): StepResult =>
  StepResult.parse({ step, state: "skipped", reason: `Nothing is set up for ${step}.`, failing: [], actions: [], checkedAt: MANUAL_CLOCK_START, ...fields });
