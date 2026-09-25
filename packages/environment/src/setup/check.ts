import type { RegisteredStep, SettingsValues, SetupAction, StateCheckId, StepResult } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";

/**
 * One step's health check (ADR 0031; #141): the value check of every key
 * the step writes, then each of its state checks, in the registry entry's
 * order. Done when every one holds, with the entry's own line (its state
 * checks' sentences, or that its settings hold valid values); otherwise
 * needs attention, the line naming every check that failed, with the
 * failing checks' actions, each once. A step is never skipped here: only a
 * person skips a skippable step, and none is registered yet.
 */

/** How the environment answers each state check the registry names: the type makes a missing one a compile error. */
export type StateCheckers = { readonly [Id in StateCheckId]: () => StateCheckAnswer };

/** The line of a done step with no state checks. */
const VALUES_HOLD = "Every setting it writes holds a valid value.";

interface Failure {
  readonly id: string;
  readonly reason: string;
  readonly actions: readonly SetupAction[];
}

/** A state check's answer; one that throws could not check, which needs attention too. */
const answerOf = (id: StateCheckId, checker: () => StateCheckAnswer): StateCheckAnswer => {
  try {
    return checker();
  } catch (error) {
    return { reason: `Could not check ${id}: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}.` };
  }
};

export const checkStep = (step: RegisteredStep, values: SettingsValues, checkers: StateCheckers, checkedAt: string): StepResult => {
  const failures: Failure[] = [];
  for (const { key, check } of step.checks) {
    const answer = check(values[key]);
    if (answer !== true) failures.push({ id: key, reason: answer, actions: [] });
  }
  for (const stateCheck of step.stateChecks) {
    const answer = answerOf(stateCheck.id, checkers[stateCheck.id]);
    if (answer !== true) failures.push({ id: stateCheck.id, reason: answer.reason, actions: stateCheck.actions });
  }
  if (failures.length === 0) {
    const reason = step.stateChecks.length === 0 ? VALUES_HOLD : step.stateChecks.map((stateCheck) => stateCheck.holds).join(" ");
    return { step: step.id, state: "done", reason, failing: [], actions: [], checkedAt };
  }
  return {
    step: step.id,
    state: "needs-attention",
    reason: failures.map((failure) => failure.reason).join(" "),
    failing: failures.map((failure) => failure.id),
    actions: [...new Set(failures.flatMap((failure) => failure.actions))],
    checkedAt,
  };
};
