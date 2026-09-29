import type { LastGood, RegisteredStepId, SettingsValues, SetupAction, StateCheck, StateCheckId, Step, StepResult } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock, Timer } from "../serve/clock.js";

/**
 * One step's health check (ADR 0031; #141, #308). A skippable step's skip
 * check runs first: when it fails, nothing is set up to check, and the step
 * answers skipped with its line and runs nothing else. Otherwise the value
 * check of every key the step writes runs, and its other state checks all
 * at once, each answering at once or with a promise. Done when every one
 * holds, with the entry's own line (its state checks' sentences, or that its
 * settings hold valid values); otherwise needs attention, the line naming
 * every check that failed, with the failing checks' actions, each once. A
 * check that throws or rejects could not check, which needs attention too.
 * Past the step's budget it answers that it timed out, with Check again,
 * whatever its checks answer later. A result that timed out or could not
 * check carries the step's last good result beneath it.
 */

/** How the environment answers one state check: at once, or with a promise the check awaits within its step's budget. */
export type StateChecker = () => StateCheckAnswer | Promise<StateCheckAnswer>;

/** How the environment answers each state check the registry names: the type makes a missing one a compile error. */
export type StateCheckers = { readonly [Id in StateCheckId]: StateChecker };

/** A step `setup.check` runs: a registry entry, or a test's own step under a registered step's id. */
export type CheckedStep = Step & { readonly id: RegisteredStepId };

/** What a step's check reads beyond the step itself. */
export interface CheckContext {
  readonly values: SettingsValues;
  /** How the environment answers each of the step's state checks, by id. */
  readonly stateChecks: { readonly [id: string]: StateChecker };
  /** The clock the budget runs on. */
  readonly clock: Clock;
  readonly checkedAt: string;
  /** The step's last good result, which a result that timed out or could not check carries. */
  readonly lastGood: LastGood | undefined;
}

/** The line of a done step with no state checks. */
const VALUES_HOLD = "Every setting it writes holds a valid value.";

/** A check that did not hold, or that could not check because it threw or rejected. */
interface Failure {
  readonly id: string;
  readonly reason: string;
  readonly actions: readonly SetupAction[];
  readonly couldNotCheck: boolean;
}

const TIMED_OUT = Symbol("timed out");

export const checkStep = async (step: CheckedStep, context: CheckContext): Promise<StepResult> => {
  const { checkedAt, lastGood } = context;
  /** The state checks called and not answered yet: what a timeout names. */
  const unanswered = new Set<string>();

  const ask = async ({ id, actions }: StateCheck): Promise<true | Failure> => {
    unanswered.add(id);
    try {
      const answer = await (context.stateChecks[id] as StateChecker)();
      return answer === true || { id, reason: answer.reason, actions, couldNotCheck: false };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      return { id, reason: `Could not check ${id}: ${message}.`, actions, couldNotCheck: true };
    } finally {
      unanswered.delete(id);
    }
  };

  /** Needs attention, naming each failure; the last good result beneath when one could not check. */
  const failed = (failures: readonly Failure[]): StepResult => ({
    step: step.id,
    state: "needs-attention",
    reason: failures.map((failure) => failure.reason).join(" "),
    failing: failures.map((failure) => failure.id),
    actions: [...new Set(failures.flatMap((failure) => failure.actions))],
    checkedAt,
    ...(failures.some((failure) => failure.couldNotCheck) && lastGood !== undefined && { lastGood }),
  });

  const run = async (): Promise<StepResult> => {
    const skipCheck = step.stateChecks.find((stateCheck) => stateCheck.id === step.skip);
    if (skipCheck !== undefined) {
      const answer = await ask(skipCheck);
      if (answer !== true && answer.couldNotCheck) return failed([answer]);
      if (answer !== true) return { step: step.id, state: "skipped", reason: answer.reason, failing: [], actions: [], checkedAt };
    }
    const failures: Failure[] = [];
    for (const { key, check } of step.checks) {
      const answer = check(context.values[key]);
      if (answer !== true) failures.push({ id: key, reason: answer, actions: [], couldNotCheck: false });
    }
    const answers = await Promise.all(step.stateChecks.filter((stateCheck) => stateCheck !== skipCheck).map(ask));
    for (const answer of answers) if (answer !== true) failures.push(answer);
    if (failures.length > 0) return failed(failures);
    const reason = step.stateChecks.length === 0 ? VALUES_HOLD : step.stateChecks.map((stateCheck) => stateCheck.holds).join(" ");
    return { step: step.id, state: "done", reason, failing: [], actions: [], checkedAt };
  };

  let timer: Timer | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = context.clock.setTimeout(() => resolve(TIMED_OUT), step.budgetSeconds * 1000);
  });
  try {
    const result = await Promise.race([run(), budget]);
    if (result !== TIMED_OUT) return result;
    return {
      step: step.id,
      state: "needs-attention",
      reason: `could not check: timed out after ${step.budgetSeconds} s`,
      failing: step.stateChecks.filter((stateCheck) => unanswered.has(stateCheck.id)).map((stateCheck) => stateCheck.id),
      actions: ["check-again"],
      checkedAt,
      ...(lastGood !== undefined && { lastGood }),
    };
  } finally {
    timer?.cancel();
  }
};
