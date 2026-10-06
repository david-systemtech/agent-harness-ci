import { STEP_REGISTRY, type RegisteredStepId, type Step } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../src/permissions/step-checks.js";
import type { CheckedStep, StateChecker } from "../src/setup/check.js";
import type { SetupSteps } from "../src/setup/service.js";

/**
 * Scripted steps for `setup.check` and the checks the environment starts
 * itself, through the in-process environment (ADR 0031; #308, #571): a step
 * of the test's own under a registered step's id, and a state check the
 * test answers by hand, so an answer comes late on the manual clock, or
 * never, or one that answers at once what the test last set.
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

export interface AnsweringCheck {
  readonly checker: StateChecker;
  /** Sets what each call answers from now on: it holds, the line saying what does not, or an error it throws. */
  answer(answer: StateCheckAnswer | Error): void;
  /** How many times the check has been called. */
  calls(): number;
}

/** A state check that answers every call at once with what the test last set, holding until told otherwise. */
export const answeringCheck = (): AnsweringCheck => {
  let current: StateCheckAnswer | Error = true;
  let calls = 0;
  return {
    checker: () => {
      calls += 1;
      if (current instanceof Error) throw current;
      return current;
    },
    answer: (answer) => void (current = answer),
    calls: () => calls,
  };
};

/**
 * A step of the test's own under a registered step's id and home row: it
 * writes no settings, and has the given state checks, the local budget, an
 * hourly cadence, no triggers and the line "Set up here." when done unless
 * told otherwise.
 */
export const scriptedStep = (id: RegisteredStepId, parts: Partial<Omit<Step, "id">> = {}): CheckedStep => ({
  id,
  home: (STEP_REGISTRY.find((step) => step.id === id) as CheckedStep).home,
  writes: [],
  checks: [],
  stateChecks: [],
  done: "Set up here.",
  links: [],
  skippable: false,
  budget: "local",
  cadence: { minutes: 60 },
  triggers: [],
  ...parts,
});

/**
 * No step: for a suite that counts a feature's own work, a forge's requests
 * or its verifications, which the Forges step's check, run on start, on its
 * cadence and on its triggers (#571), would add to.
 */
export const NO_SETUP_STEPS: SetupSteps = { steps: [], stateChecks: {} };
