import {
  CHECK_BUDGET_SECONDS,
  STEP_RESULT_DETAILS_MAX,
  type LastGood,
  type ReasonTime,
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
import type { StepSubject } from "./mint.js";
import type { StoppedRun } from "./minted.js";

/**
 * One step's health check (ADR 0031; #141, #308, #568). A skippable step's
 * skip check runs first: when it fails, nothing is set up to check, and the
 * step answers skipped with its line and runs nothing else. Skipped is
 * derived from state this way on every check and never recorded: nothing a
 * person does skips a step. Otherwise the value check of every key the step
 * writes runs, and its other state checks all at once, each answering at
 * once or with a promise. Done when every one holds, with one sentence of
 * what was found (#1698): the environment's line for the step, else the
 * entry's `done`, never its state checks' conditions, followed by what a
 * check that holds says it found; otherwise needs attention, the line naming every check that
 * failed, with the failing checks' actions, each once, and the items those
 * checks named for their actions, each once. A check that throws or rejects
 * could not check, which needs attention too, with Check again. Past the
 * seconds of the step's budget class it answers that it took too long, with
 * Check again, whatever its checks answer later. A result that timed out or
 * could not check carries the step's last good result beneath it.
 *
 * Its line is plain words (setup-copy.md §1.7, §3; #1836): each failure's
 * own sentence, each once, and the raw facts behind them, the ids of the
 * checks that threw with their errors, settings keys, addresses, versions
 * and exact times, in its details, each once, at most twenty.
 *
 * Each state check is told how old a finding of its feature's own schedule
 * may be for it to read that finding rather than ask the feature again
 * (#680): the step's cadence when the environment checks the step itself,
 * so a step whose feature keeps its own schedule adds no work beside it;
 * none when a client asked, which checks fresh (ADR 0031: opening Set up or
 * the step's pane, Check now, Check again and re-run).
 *
 * An LLM step (ADR 0019; #584) reads its minted sessions beside its
 * checks. Done, it offers `revise`, targeting each of its subjects, the one
 * action a done result carries. Needing attention after its latest minted
 * session's last run ended with an error or was stopped, its line opens
 * with that error or "stopped" and it offers `try-again`, targeting that
 * session, `write-it-myself` and `start-over` before its checks' own
 * actions, for each subject's latest session, with the latter two targeting
 * that session's subject; after a clean end, its line names what is missing, as any
 * step's does. A check that could not check says only that. The line says the
 * describing conversation stopped (setup-copy.md §5.8), its error in details.
 */

/** Who asked for a step's check: a client, through `setup.check`, or the environment's own schedule, its start pass, cadence and triggers (#571). */
export type CheckAsker = "client" | "schedule";

/** What a state check is told of the check that asks it. */
export interface StateCheckRequest {
  /** How old a finding of the feature's own schedule may be to be read as it is: the step's cadence on the schedule's check, 0 on a client's. */
  readonly maxAgeMs: number;
}

/** How the environment answers one state check: at once, or with a promise the check awaits within its step's budget. */
export type StateChecker = (request: StateCheckRequest) => StateCheckAnswer | Promise<StateCheckAnswer>;

/** What the environment found of a step: its plain line, the raw facts behind it for Details, and the past times the line names. */
export interface Finding {
  readonly reason: string;
  readonly details?: readonly string[];
  readonly times?: readonly ReasonTime[];
}

/**
 * The environment's line for a step that is done, from what it finds when
 * asked (#1698): Carry over's source folder and its last import, Your
 * machines' name and updates, its version and reach in details. Undefined
 * leaves the entry's `done`.
 */
export type DoneLine = (request: StateCheckRequest) => Finding | undefined | Promise<Finding | undefined>;

/** The steps the environment says more of when done than the entry's `done`, by id. */
export type DoneLines = { readonly [Id in RegisteredStepId]?: DoneLine };

/** How the environment answers each state check the registry names: the type makes a missing one a compile error. */
export type StateCheckers = { readonly [Id in StateCheckId]: StateChecker };

/** A step `setup.check` runs: a registry entry, or a test's own step under a registered step's id. */
export type CheckedStep = Step & { readonly id: RegisteredStepId };

/** What an LLM step's check reads of its subjects and its minted sessions (#584). */
export interface LlmStepReads {
  /** The subjects a done step's Revise targets. */
  subjects(): readonly StepSubject[];
  /** Each subject's latest minted session whose last run failed or stopped. */
  stopped(): readonly StoppedRun[];
}

/** What a step's check reads beyond the step itself. */
export interface CheckContext {
  readonly values: SettingsValues;
  /** How the environment answers each of the step's state checks, by id. */
  readonly stateChecks: { readonly [id: string]: StateChecker };
  /** The environment's line for the step when it is done; absent, the entry's `done`. */
  readonly doneLine?: DoneLine;
  /** The clock the budget runs on. */
  readonly clock: Clock;
  readonly checkedAt: string;
  /** Who asked for the check. */
  readonly askedBy: CheckAsker;
  /** The step's last good result, which a result that timed out or could not check carries. */
  readonly lastGood: LastGood | undefined;
  /** On an LLM step, its subjects and how its minted session last ended; absent on any other step. */
  readonly llm?: LlmStepReads;
}

/** What a stopped minted session offers, before its step's checks' own actions. */
const STOPPED_RUN_ACTIONS: readonly SetupAction[] = ["try-again", "write-it-myself", "start-over"];

/** The line a result opens with when a minted session's run stopped, with an error or not (setup-copy.md §5.8): the error is in details. */
const STOPPED_LINE = "The describing conversation stopped.";

/** A check that threw or rejected (setup-copy.md §3): its id and error are in details. */
const COULD_NOT_FINISH = "agent-harness could not finish checking this step. Choose Check again.";

/** A step whose checks did not answer within its budget (setup-copy.md §3). */
const TOOK_TOO_LONG = "Checking took too long. Choose Check again.";

/** Lines of details as a result carries them: each on one line, each once, at most the twenty a result holds. */
const detailLines = (lines: readonly string[]): string[] =>
  [...new Set(lines.map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== ""))].slice(0, STEP_RESULT_DETAILS_MAX);

/** A result's details, absent when there are none. */
const withDetails = (lines: readonly string[]): { details?: string[] } => {
  const details = detailLines(lines);
  return details.length > 0 ? { details } : {};
};

/** A check that did not hold, or that could not check because it threw or rejected. */
interface Failure {
  readonly id: string;
  readonly reason: string;
  /** The raw facts behind its reason. */
  readonly details: readonly string[];
  readonly actions: readonly SetupAction[];
  /** The items its actions apply to, as it named them. */
  readonly targets: readonly SetupTarget[];
  /** The past times its reason names. */
  readonly times?: readonly ReasonTime[];
  readonly couldNotCheck: boolean;
  readonly pending?: true;
}

/** The targets in their order, each once: a target is its action, kind and id. */
const uniqueTargets = (targets: readonly SetupTarget[]): SetupTarget[] => {
  const seen = new Map<string, SetupTarget>();
  for (const target of targets) {
    const key = JSON.stringify([target.action, target.kind, target.id]);
    if (!seen.has(key)) seen.set(key, target);
  }
  return [...seen.values()];
};

/** A done step's line from what the environment found, else the entry's `done`, which stands too when what was found cannot be read. */
const foundLine = async (step: CheckedStep, doneLine: DoneLine, request: StateCheckRequest): Promise<Finding> => {
  try {
    return (await doneLine(request)) ?? { reason: step.done };
  } catch {
    return { reason: step.done };
  }
};

const TIMED_OUT = Symbol("timed out");

export const checkStep = async (step: CheckedStep, context: CheckContext): Promise<StepResult> => {
  const { checkedAt, lastGood } = context;
  const request: StateCheckRequest = { maxAgeMs: context.askedBy === "client" ? 0 : step.cadence.minutes * 60_000 };
  /** The state checks called and not answered yet: what a timeout names. */
  const unanswered = new Set<string>();
  const holdingLines = new Map<string, Finding>();

  const ask = async ({ id, actions: declared }: StateCheck): Promise<true | Failure> => {
    unanswered.add(id);
    try {
      const answer = await (context.stateChecks[id] as StateChecker)(request);
      if (answer === true) return true;
      if (answer.holds) {
        holdingLines.set(id, answer);
        return true;
      }
      const actions = answer.actions?.filter((action) => declared.includes(action)) ?? declared;
      const targets = (answer.targets ?? []).filter((target) => actions.includes(target.action));
      return {
        id,
        reason: answer.reason,
        details: answer.details ?? [],
        actions,
        targets,
        ...(answer.times !== undefined && { times: answer.times }),
        couldNotCheck: false,
        ...(answer.pending && { pending: true }),
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      return { id, reason: COULD_NOT_FINISH, details: [`${id}: ${message}`], actions: ["check-again"], targets: [], couldNotCheck: true };
    } finally {
      unanswered.delete(id);
    }
  };

  /**
   * Needs attention, naming each failure, with the items the failures named;
   * the last good result beneath when one could not check. After a minted
   * session's run that stopped, its line and its actions come first.
   */
  const failed = (failures: readonly Failure[], stopped: readonly StoppedRun[] = []): StepResult => {
    const mintedTargets = stopped.flatMap((run): SetupTarget[] => [
      { action: "try-again", kind: "session", id: run.sessionId, label: run.title },
      ...(run.subject === null ? [] : [
        { action: "write-it-myself" as const, ...run.subject },
        { action: "start-over" as const, ...run.subject },
      ]),
    ]);
    const targets = uniqueTargets([...mintedTargets, ...failures.flatMap((failure) => failure.targets)]);
    const times = failures.flatMap((failure) => failure.times ?? []);
    const stoppedErrors = stopped.flatMap((run) => (run.error === null ? [] : [run.error]));
    return {
      step: step.id,
      state: "needs-attention",
      reason: [...new Set([...(stopped.length === 0 ? [] : [STOPPED_LINE]), ...failures.map((failure) => failure.reason)])].join(" "),
      ...withDetails([...stoppedErrors, ...failures.flatMap((failure) => failure.details)]),
      failing: failures.map((failure) => failure.id),
      actions: [...new Set([...(stopped.length === 0 ? [] : STOPPED_RUN_ACTIONS), ...failures.flatMap((failure) => failure.actions)])],
      ...(targets.length > 0 && { targets }),
      ...(times.length > 0 && { times }),
      checkedAt,
      ...(failures.some((failure) => failure.couldNotCheck) && lastGood !== undefined && { lastGood }),
    };
  };

  const run = async (): Promise<StepResult> => {
    const failures: Failure[] = [];
    const skipCheck = step.stateChecks.find((stateCheck) => stateCheck.id === step.skip);
    if (skipCheck !== undefined) {
      const answer = await ask(skipCheck);
      if (answer !== true && answer.couldNotCheck) return failed([answer]);
      if (answer !== true) {
        if (!answer.pending) return { step: step.id, state: "skipped", reason: answer.reason, failing: [], actions: [], checkedAt };
        failures.push(answer);
      }
    }
    for (const { key, check } of step.checks) {
      const answer = check(context.values[key]);
      if (answer !== true) failures.push({ id: key, reason: answer.reason, details: answer.details, actions: [], targets: [], couldNotCheck: false });
    }
    const answers = await Promise.all(step.stateChecks.filter((stateCheck) => stateCheck !== skipCheck).map(ask));
    for (const answer of answers) if (answer !== true) failures.push(answer);
    const { llm } = context;
    const pending = failures.filter((failure) => failure.pending);
    const failedChecks = failures.filter((failure) => !failure.pending);
    if (failedChecks.length > 0) {
      const couldNotCheck = failedChecks.some((failure) => failure.couldNotCheck);
      return failed(failedChecks, llm === undefined || couldNotCheck ? [] : llm.stopped());
    }
    if (pending.length > 0) return { step: step.id, state: "pending", reason: pending.map((check) => check.reason).join(" "), failing: [], actions: [], checkedAt };
    // Awaited only when the environment says more, so a step it does not answers as soon as its checks have.
    const line = context.doneLine === undefined ? { reason: step.done } : await foundLine(step, context.doneLine, request);
    const found = [line, ...step.stateChecks.flatMap((stateCheck) => holdingLines.get(stateCheck.id) ?? [])];
    const done = {
      step: step.id,
      state: "done" as const,
      reason: found.map((finding) => finding.reason).join(" "),
      ...withDetails(found.flatMap((finding) => finding.details ?? [])),
      ...(line.times !== undefined && line.times.length > 0 && { times: [...line.times] }),
      failing: [],
    };
    if (llm === undefined) return { ...done, actions: [], checkedAt };
    const targets = llm.subjects().map((subject): SetupTarget => ({ action: "revise", ...subject }));
    return { ...done, actions: ["revise"], ...(targets.length > 0 && { targets }), checkedAt };
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
      reason: TOOK_TOO_LONG,
      details: [`Stopped after ${seconds} seconds.`],
      failing: step.stateChecks.filter((stateCheck) => unanswered.has(stateCheck.id)).map((stateCheck) => stateCheck.id),
      actions: ["check-again"],
      checkedAt,
      ...(lastGood !== undefined && { lastGood }),
    };
  } finally {
    timer?.cancel();
  }
};
