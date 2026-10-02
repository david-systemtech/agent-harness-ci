import { SettingsUpdatedPayload, triggerMatches, type RegisteredStepId } from "@agent-harness/contracts";
import type { EventEnvelope } from "../event-log/envelope.js";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import type { CheckedStep } from "./check.js";
import { mintedRunEnd } from "./minted.js";
import type { SetupService } from "./service.js";

/**
 * The checks the environment starts itself (the Set up specification,
 * "Running checks"; ADR 0031; #571), through the SetupService, so each
 * result is kept, noticed when it changed, and runs as `system:setup`
 * whoever else is asking, with no client connected:
 *
 * - **The start pass**: every registered step, once, when the environment
 *   has started, past the update coordinator's settle. The routines
 *   scheduler's start pass (#535) runs after it.
 * - **The cadence**: a step is checked again once its cadence (the entry's
 *   minutes, sixty unless it gives a reason) has passed since its cached
 *   result's checked-at, whatever checked it last, so across a restart it
 *   counts from the checked-at the cache kept. Never more than a cadence
 *   from now, so a clock set back delays no check.
 * - **The triggers**: an event or notice whose type a step names (one type,
 *   or a family ending in `*`), appended on any stream, has the step checked
 *   a second after it arrived, and every trigger inside that second joins
 *   the one check. `settings.updated` triggers a step only when the keys it
 *   names include one the step writes. A change a step's checks read that
 *   the log does not record is named to `trigger` in process, and triggers
 *   the step the same way: each check of the release channel as it ends,
 *   for Your machines (#679). Every run end of a minted session, a
 *   session tagged `setup` and a step's id (ADR 0019; #584), triggers that
 *   step the same way, so an LLM step's check detects its artefact when the
 *   conversation stops, never on a timeout.
 *
 * A step's check never runs twice at once: the cadence or a `setup.check`
 * that arrives while it runs takes that run's result (`service.ts`). A
 * trigger that arrives while it runs is heard again as the run ends, so the
 * step is checked a second after it (#678): the run read the settings as it
 * started and each state check as it asked it, so it may have missed the
 * trigger's change. That is any trigger, what the check's own verification
 * records included (a forge account's `forge.account.verified`, appended only
 * on a change), so a check whose verification found a change is followed by
 * one more.
 */

/** How long after a trigger arrives its step is checked, every trigger inside it joining the one check. */
export const TRIGGER_WINDOW_MS = 1_000;

export interface SetupSchedulerOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The registered steps, whose cadences and triggers the scheduler keeps. */
  readonly steps: readonly CheckedStep[];
  readonly setup: SetupService;
}

export interface SetupScheduler {
  /** Settles once the start pass has checked every registered step. */
  readonly startPass: Promise<void>;
  /**
   * Something `step`'s checks read changed and no event records it: the step
   * is checked as an event it names would have it checked. A step the
   * registry does not hold is left alone.
   */
  trigger(step: RegisteredStepId): void;
  /** Stops the cadences and the triggers; a check running is left to finish. */
  stop(): void;
}

/** Whether `event` fires one of `step`'s triggers: for `settings.updated`, only when it names a key the step writes. */
const fires = (step: CheckedStep, event: EventEnvelope): boolean => {
  if (!step.triggers.some((trigger) => triggerMatches(trigger, event.type))) return false;
  if (event.type !== "settings.updated") return true;
  const payload = SettingsUpdatedPayload.safeParse(event.payload);
  return payload.success && Object.keys(payload.data.values).some((key) => (step.writes as readonly string[]).includes(key));
};

/** Starts the environment's own checks: the start pass now, then each step on its cadence and on its triggers. */
export const startSetupScheduler = (options: SetupSchedulerOptions): SetupScheduler => {
  const { log, clock, steps, setup } = options;
  let stopped = false;
  const cadences = new Map<RegisteredStepId, Timer>();
  const triggered = new Map<RegisteredStepId, Timer>();
  /** The steps a trigger arrived for while their check ran, each heard again once that run ends. */
  const owed = new Set<RegisteredStepId>();

  const cadenceMs = (step: CheckedStep): number => step.cadence.minutes * 60_000;

  /** Checks the step, or takes the result of its check that is running. */
  const check = (step: CheckedStep, why: string): Promise<void> =>
    setup.check(step.id).then(
      () => undefined,
      (error: unknown) => {
        if (!stopped) console.error(`Set up's check of ${step.id} ${why} failed; its cadence checks it again:`, error);
      },
    );

  const arm = (step: CheckedStep, ms: number): void => {
    cadences.set(step.id, clock.setTimeout(() => due(step), ms));
  };

  /**
   * The step's cadence fell due. A result younger than its cadence is cached
   * (a check since, asked for or triggered): the cadence counts from it.
   * Otherwise it is checked now, and falls due again a cadence from now. A
   * cached result from later than now (a clock set back) counts as due, so
   * no step waits longer than its cadence.
   */
  const due = (step: CheckedStep): void => {
    const cached = setup.cached().find((result) => result.step === step.id);
    const left = cached === undefined ? 0 : Date.parse(cached.checkedAt) + cadenceMs(step) - clock.now().getTime();
    if (left > 0 && left <= cadenceMs(step)) return arm(step, left);
    void check(step, "on its cadence");
    arm(step, cadenceMs(step));
  };

  /**
   * A trigger of the step arrived: it is checked a second from now, unless an
   * earlier trigger's second is running, which this one joins. A check that
   * started inside the second read the state after the trigger's change, so
   * the trigger takes its result. One that arrives while the step's check
   * runs is owed a check once the run ends.
   */
  const trigger = (step: CheckedStep): void => {
    if (stopped) return;
    const run = setup.running(step.id);
    if (run !== undefined) return owe(step, run);
    if (triggered.has(step.id)) return;
    triggered.set(
      step.id,
      clock.setTimeout(() => {
        triggered.delete(step.id);
        void check(step, "on a trigger");
      }, TRIGGER_WINDOW_MS),
    );
  };

  /** Hears the step's trigger again as `run`, the check it arrived during, ends: every trigger during one run is heard once. */
  const owe = (step: CheckedStep, run: Promise<void>): void => {
    if (owed.has(step.id)) return;
    owed.add(step.id);
    void run.then(() => {
      owed.delete(step.id);
      trigger(step);
    });
  };

  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const unsubscribe = log.subscribe((event) => {
    const minted = mintedRunEnd(reader, event);
    for (const step of steps) if (fires(step, event) || minted.has(step.id)) trigger(step);
  });
  const startPass = Promise.all(
    steps.map((step) => {
      const checked = check(step, "at the start");
      arm(step, cadenceMs(step));
      return checked;
    }),
  ).then(() => undefined);

  return {
    startPass,
    trigger(id) {
      const step = steps.find((entry) => entry.id === id);
      if (step !== undefined) trigger(step);
    },
    stop() {
      stopped = true;
      unsubscribe();
      for (const timer of [...cadences.values(), ...triggered.values()]) timer.cancel();
      cadences.clear();
      triggered.clear();
    },
  };
};
