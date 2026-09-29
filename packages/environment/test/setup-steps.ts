import { STEP_REGISTRY, type RegisteredStepId, type Step } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../src/permissions/step-checks.js";
import type { CheckedStep, StateChecker } from "../src/setup/check.js";

/**
 * Scripted steps for `setup.check` through the in-process environment
 * (ADR 0031; #308): a step of the test's own under a registered step's id,
 * and a state check the test answers by hand, so an answer comes late on
 * the manual clock, or never.
 */

/** One call of a check answered by hand. */
export interface LateCall {
  /** Answers the call: it holds, or the line saying what does not. */
  answer(answer: StateCheckAnswer): void;
  /** Rejects the call. */
  fail(error: Error): void;
}

export interface LateCheck {
  readonly checker: StateChecker;
  /** The `n`th call, counting from 1, once the check has been called that often. */
  call(n: number): Promise<LateCall>;
  /** How many times the check has been called. */
  calls(): number;
}

/** A state check that answers each call only when the test says. */
export const lateCheck = (): LateCheck => {
  const calls: LateCall[] = [];
  const waiting = new Set<() => void>();
  return {
    checker: () =>
      new Promise<StateCheckAnswer>((resolve, reject) => {
        calls.push({ answer: resolve, fail: reject });
        for (const wake of waiting) wake();
      }),
    call: (n) =>
      new Promise((resolve) => {
        const settle = () => {
          const call = calls[n - 1];
          if (call === undefined) return;
          waiting.delete(settle);
          resolve(call);
        };
        waiting.add(settle);
        settle();
      }),
    calls: () => calls.length,
  };
};

/**
 * A step of the test's own under a registered step's id and home row: it
 * writes no settings, and has the given state checks, a five-second budget
 * and an hourly cadence unless told otherwise.
 */
export const scriptedStep = (id: RegisteredStepId, parts: Partial<Omit<Step, "id">> = {}): CheckedStep => ({
  id,
  home: (STEP_REGISTRY.find((step) => step.id === id) as CheckedStep).home,
  writes: [],
  checks: [],
  stateChecks: [],
  links: [],
  skippable: false,
  budgetSeconds: 5,
  cadence: { minutes: 60 },
  ...parts,
});
