import { isDeepStrictEqual } from "node:util";
import { StepResult, type LastGood, type RegisteredStepId, type SettingsValues, type StepId } from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import { checkStep, type CheckAsker, type CheckContext, type CheckedStep, type DoneLines, type StateChecker } from "./check.js";
import type { LlmSteps } from "./mint.js";
import { stoppedMintedRuns } from "./minted.js";

/**
 * The SetupService (the Set up specification, "Modules", "Results, the
 * cache and the subscription" and "Running checks"; ADR 0031; #141, #308,
 * #569, #571): runs a registered step's health check on this environment
 * now, or every registered step's at once, reading the settings as they are
 * and asking the state checks the environment was started with, and answers
 * once each step has answered or run out of its budget, in the registry's
 * order. A step's check never runs twice at once: asked for while it runs,
 * by `setup.check` or by the scheduler (`scheduler.ts`), a step takes that
 * run's result.
 *
 * Each result is kept in the result cache (`result-table.ts`), one row per
 * step beside the event log, which survives a restart with its checked-at
 * and which no check reads; `cached` reads it back for
 * `environment.subscribe`'s snapshot and the scheduler's cadence. A step's
 * first result, and one that differs from the cached one in anything but its
 * checked-at, appends `setup.result-changed` with the result on the
 * environment stream, as `system:setup` and in the transaction that writes
 * the row; one that only refreshes its checked-at updates the row and
 * appends nothing. A result that timed out or could not check carries the
 * last good result the cache holds: the cached result when it passed, done
 * or skipped, else the one the cached result carried, so it survives a
 * restart.
 */

/** Who appends `setup.result-changed`: Set up itself, whoever asked for the check. */
const SETUP_ACTOR = formatActor({ kind: "system", id: "setup" });

/** The steps the service checks, in order, how the environment answers their state checks, by id, its lines for those done (#1698), and the LLM steps' prompts and own sides (`mint.ts`). */
export interface SetupSteps extends LlmSteps {
  readonly steps: readonly CheckedStep[];
  readonly stateChecks: { readonly [id: string]: StateChecker };
  readonly doneLines?: DoneLines;
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
  /**
   * Checks `step` now, or every registered step when none is named; answers
   * the results in the registry's order, each kept in the cache first. A
   * step whose check is running is not checked again: it answers that run's
   * result, whoever asked for it. The environment's own schedule asks
   * unless a client is named, as `setup.check` names one (`methods.ts`).
   */
  check(step?: RegisteredStepId, askedBy?: CheckAsker): Promise<StepResult[]>;
  /** Settles once `step`'s check that is running now has ended, whatever it answered; undefined when none is running. */
  running(step: RegisteredStepId): Promise<void> | undefined;
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

/**
 * Whether a cached row holds `result` but for when it was checked. The row
 * is compared as written, not as this build reads it: one a newer version
 * wrote may offer a verb or name a kind of item this build's reading leaves
 * out (#693), and a result without them differs from it, so a client that
 * heard the newer one is told.
 */
const sameButCheckedAt = (row: string | undefined, result: StepResult): boolean => {
  if (row === undefined) return false;
  try {
    return isDeepStrictEqual({ ...(JSON.parse(row) as object), checkedAt: "" }, { ...result, checkedAt: "" });
  } catch {
    return false;
  }
};

/** The last good result a step's cached result leaves for one that timed out or could not check: it, when it passed; else the one it carried. */
const lastGoodOf = (cached: StepResult | undefined): LastGood | undefined => {
  if (cached === undefined) return undefined;
  if (cached.state === "needs-attention" || cached.state === "pending") return cached.lastGood;
  return { state: cached.state, reason: cached.reason, checkedAt: cached.checkedAt };
};

export const createSetupService = (options: SetupServiceOptions): SetupService => {
  const { log, clock, steps, stream } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** Each step's check that is running, which a call for the step while it runs takes the result of. */
  const running = new Map<RegisteredStepId, Promise<StepResult>>();

  const cachedResult = (step: StepId): StepResult | undefined => readResult(log.setupResults.read(step));

  /** Writes `result` to its step's row, and appends its notice when it changed. */
  const keep = (result: StepResult): void => {
    log.atomically((tx) => {
      const row = log.setupResults.read(result.step);
      log.setupResults.write(tx, result.step, JSON.stringify(result));
      if (sameButCheckedAt(row, result)) return;
      log.append(stream, [{ type: "setup.result-changed", payload: result }], { actor: SETUP_ACTOR, tx });
    });
  };

  /** Checks `step`, or takes the result of its check that is running; it reads the settings and the clock as it is called. */
  const checkOne = (step: CheckedStep, askedBy: CheckAsker): Promise<StepResult> => {
    const underway = running.get(step.id);
    if (underway !== undefined) return underway;
    const llmStep = step.llm === undefined ? undefined : steps.llmSteps?.[step.id];
    const context: CheckContext = {
      values: readSettings(reader, options.presets),
      stateChecks: steps.stateChecks,
      ...(steps.doneLines?.[step.id] !== undefined && { doneLine: steps.doneLines[step.id] }),
      clock,
      checkedAt: clock.now().toISOString(),
      askedBy,
      lastGood: lastGoodOf(cachedResult(step.id)),
      ...(llmStep !== undefined && { llm: { subjects: () => llmStep.subjects(), stopped: () => stoppedMintedRuns(reader, step.id) } }),
    };
    let settle!: (run: Promise<StepResult>) => void;
    const current = new Promise<StepResult>((resolve) => (settle = resolve)).finally(() => running.delete(step.id));
    // Recorded as running before its state checks are asked, so an event one of them appends at once finds it so.
    running.set(step.id, current);
    settle(
      checkStep(step, context).then((result) => {
        keep(result);
        return result;
      }),
    );
    return current;
  };

  return {
    // Async, so a read that throws as a check starts rejects the call rather than throwing at its caller.
    check: async (id, askedBy = "schedule") => Promise.all(steps.steps.filter((entry) => id === undefined || entry.id === id).map((entry) => checkOne(entry, askedBy))),
    running: (id) => running.get(id)?.then(
      () => undefined,
      () => undefined,
    ),
    cached() {
      const rows = new Map(log.setupResults.all().map((row) => [row.step, row.result]));
      return steps.steps.flatMap((entry) => readResult(rows.get(entry.id)) ?? []);
    },
  };
};
