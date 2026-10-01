import {
  CHECK_BUDGET_SECONDS,
  type LastGood,
  type RegisteredStepId,
  type SettingsValues,
  type SetupAction,
  type SetupTarget,
  type StateCheck,
  type StateCheckId,
  type Step,
  type StepResult,
} from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { AuthoringSubject } from "./mint.js";
import type { StoppedRun } from "./minted.js";

/**
 * One step's health check (ADR 0031; #141, #308, #568). A skippable step's
 * skip check runs first: when it fails, nothing is set up to check, and the
 * step answers skipped with its line and runs nothing else. Skipped is
 * derived from state this way on every check and never recorded: nothing a
 * person does skips a step. Otherwise the value check of every key the step
 * writes runs, and its other state checks all at once, each answering at
 * once or with a promise. Done when every one holds, with the entry's own
 * line (its state checks' sentences, or that its settings hold valid
 * values); otherwise needs attention, the line naming every check that
 * failed, with the failing checks' actions, each once, and the items those
 * checks named for their actions, each once. A check that throws or rejects
 * could not check, which needs attention too. Past the seconds of the
 * step's budget class it answers that it timed out, with Check again,
 * whatever its checks answer later. A result that timed out or could not
 * check carries the step's last good result beneath it.
 *
 * An LLM step (ADR 0019; #584) reads its minted sessions beside its
 * checks. Done, it offers `revise`, targeting each of its subjects, the one
 * action a done result carries. Needing attention after its latest minted
 * session's last run ended with an error or was stopped, its line opens
 * with that error or "stopped" and it offers `try-again`, targeting that
 * session, `write-it-myself` and `start-over` before its checks' own
 * actions; after a clean end, its line names what is missing, as any
 * step's does. A check that could not check says only that.
 */

/** How the environment answers one state check: at once, or with a promise the check awaits within its step's budget. */
export type StateChecker = () => StateCheckAnswer | Promise<StateCheckAnswer>;

/** How the environment answers each state check the registry names: the type makes a missing one a compile error. */
export type StateCheckers = { readonly [Id in StateCheckId]: StateChecker };

/** A step `setup.check` runs: a registry entry, or a test's own step under a registered step's id. */
export type CheckedStep = Step & { readonly id: RegisteredStepId };

/** What an LLM step's check reads of its subjects and its minted sessions (#584). */
export interface AuthoringFacts {
  /** The subjects a done step's Revise targets. */
  subjects(): readonly AuthoringSubject[];
  /** How the step's latest minted session's last run ended, when it ended with an error or was stopped. */
  stopped(): StoppedRun | null;
}

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
  /** On an LLM step, its subjects and how its minted session last ended; absent on any other step. */
  readonly authoring?: AuthoringFacts;
}

/** What a stopped minted session offers, before its step's checks' own actions. */
const AUTHORING_ACTIONS: readonly SetupAction[] = ["try-again", "write-it-myself", "start-over"];

/** The line a stopped minted session's run opens a result with: its error, or that it was stopped. */
const stoppedLine = ({ error }: StoppedRun): string => (error === null ? "The session's run was stopped." : `The session's run failed: ${error.replace(/\.$/, "")}.`);

/** The line of a done step with no state checks. */
const VALUES_HOLD = "Every setting it writes holds a valid value.";

/** A check that did not hold, or that could not check because it threw or rejected. */
interface Failure {
  readonly id: string;
  readonly reason: string;
  readonly actions: readonly SetupAction[];
  /** The items its actions apply to, as it named them. */
  readonly targets: readonly SetupTarget[];
  readonly couldNotCheck: boolean;
}

/** The failures' targets in their order, each once: a target is its action, kind and id. */
const targetsOf = (failures: readonly Failure[]): SetupTarget[] => {
  const seen = new Map<string, SetupTarget>();
  for (const target of failures.flatMap((failure) => failure.targets)) {
    const key = JSON.stringify([target.action, target.kind, target.id]);
    if (!seen.has(key)) seen.set(key, target);
  }
  return [...seen.values()];
};

const TIMED_OUT = Symbol("timed out");

export const checkStep = async (step: CheckedStep, context: CheckContext): Promise<StepResult> => {
  const { checkedAt, lastGood } = context;
  /** The state checks called and not answered yet: what a timeout names. */
  const unanswered = new Set<string>();

  const ask = async ({ id, actions }: StateCheck): Promise<true | Failure> => {
    unanswered.add(id);
    try {
      const answer = await (context.stateChecks[id] as StateChecker)();
      if (answer === true) return true;
      const targets = (answer.targets ?? []).filter((target) => actions.includes(target.action));
      return { id, reason: answer.reason, actions, targets, couldNotCheck: false };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      return { id, reason: `Could not check ${id}: ${message}.`, actions, targets: [], couldNotCheck: true };
    } finally {
      unanswered.delete(id);
    }
  };

  /**
   * Needs attention, naming each failure, with the items the failures named;
   * the last good result beneath when one could not check. After a minted
   * session's run that stopped, its line and its actions come first.
   */
  const failed = (failures: readonly Failure[], stopped: StoppedRun | null = null): StepResult => {
    const tryAgain: SetupTarget[] = stopped === null ? [] : [{ action: "try-again", kind: "session", id: stopped.sessionId, label: stopped.title }];
    const targets = [...tryAgain, ...targetsOf(failures)];
    return {
      step: step.id,
      state: "needs-attention",
      reason: [...(stopped === null ? [] : [stoppedLine(stopped)]), ...failures.map((failure) => failure.reason)].join(" "),
      failing: failures.map((failure) => failure.id),
      actions: [...new Set([...(stopped === null ? [] : AUTHORING_ACTIONS), ...failures.flatMap((failure) => failure.actions)])],
      ...(targets.length > 0 && { targets }),
      checkedAt,
      ...(failures.some((failure) => failure.couldNotCheck) && lastGood !== undefined && { lastGood }),
    };
  };

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
      if (answer !== true) failures.push({ id: key, reason: answer, actions: [], targets: [], couldNotCheck: false });
    }
    const answers = await Promise.all(step.stateChecks.filter((stateCheck) => stateCheck !== skipCheck).map(ask));
    for (const answer of answers) if (answer !== true) failures.push(answer);
    const { authoring } = context;
    if (failures.length > 0) {
      const couldNotCheck = failures.some((failure) => failure.couldNotCheck);
      return failed(failures, authoring === undefined || couldNotCheck ? null : authoring.stopped());
    }
    const reason = step.stateChecks.length === 0 ? VALUES_HOLD : step.stateChecks.map((stateCheck) => stateCheck.holds).join(" ");
    if (authoring === undefined) return { step: step.id, state: "done", reason, failing: [], actions: [], checkedAt };
    const targets = authoring.subjects().map((subject): SetupTarget => ({ action: "revise", ...subject }));
    return { step: step.id, state: "done", reason, failing: [], actions: ["revise"], ...(targets.length > 0 && { targets }), checkedAt };
  };

  const seconds = CHECK_BUDGET_SECONDS[step.budget];
  let timer: Timer | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = context.clock.setTimeout(() => resolve(TIMED_OUT), seconds * 1000);
  });
  try {
    const result = await Promise.race([run(), budget]);
    if (result !== TIMED_OUT) return result;
    return {
      step: step.id,
      state: "needs-attention",
      reason: `could not check: timed out after ${seconds} s`,
      failing: step.stateChecks.filter((stateCheck) => unanswered.has(stateCheck.id)).map((stateCheck) => stateCheck.id),
      actions: ["check-again"],
      checkedAt,
      ...(lastGood !== undefined && { lastGood }),
    };
  } finally {
    timer?.cancel();
  }
};
