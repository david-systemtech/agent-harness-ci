import { REGISTERED_STEP_IDS, STEP_ORDER, STEP_REGISTRY, StepResult, type StepId, type Step, type WireError } from "@agent-harness/contracts";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";

/**
 * The scripted environment's Set up (the Set up specification, "Results,
 * the cache and the subscription"; ADR 0031; #413): what `setup.check`
 * answers for each step, as the script says, every step this build
 * registers done with the environment's own line unless the script names
 * it. With the `setup` flag the environment keeps the results it last
 * checked, its start's first among them, which `environment.subscribe`'s
 * snapshot carries, and a check whose result differs from the one kept is
 * the notice `setup.result-changed`, as the environment's cache publishes
 * it. A test changes what the next check answers (`setSetup`), holds the
 * answers, for a check to read pending (`holdSetupChecks`), refuses them
 * (`refuseSetupChecks`), and has the
 * environment check with nobody asking (`passSetup`).
 */

/** A step's result as the script gives it: any field of the result but the step, over the step done; the check's time is the clock's unless it names one. */
export type ScriptedStepResult = Partial<Omit<StepResult, "step">>;

/** What `setup.check` answers for each step named; null for a step the environment gives no result for, as one whose build does not register it. */
export type ScriptedSetup = Readonly<Partial<Record<StepId, ScriptedStepResult | null>>>;

export interface ScriptedSetupHandle {
  /** Changes what `setup.check` answers from now on, over what it answers now; nothing is said until a check runs. */
  setSetup(changes: ScriptedSetup): void;
  /** Holds every `setup.check` unanswered until the function it returns is called, each then answered as the environment stands at the release. */
  holdSetupChecks(): () => void;
  /** Refuses every `setup.check` with `error` from now on, as an environment whose check cannot run does; null answers them again. */
  refuseSetupChecks(error: WireError | null): void;
  /**
   * The environment's own pass over `steps`, else every step it gives a result for, with nobody asking (its start, a
   * step's cadence or trigger, or another client's check): each checked as the script says now, and with the `setup` flag
   * a result that changed is noticed.
   */
  passSetup(steps?: readonly StepId[]): void;
}

export interface SetupHost {
  readonly clock: ManualClock;
  readonly wire: FakeWire;
  /** Whether the environment offers the `setup` flag: keeps its results for the snapshot and notices each change. */
  readonly flagged: boolean;
  readonly script: ScriptedSetup | undefined;
  /** Says a notice on the environment's own stream. */
  notice(type: string, payload: Record<string, unknown>): void;
}

/** The environment's line for a step done: its entry's one sentence of what was found (`environment/src/setup/check.ts`), or a plain one for a step no entry registers. */
const doneReason = (id: StepId): string => {
  const entry: Step | undefined = STEP_REGISTRY.find((step) => step.id === id);
  return entry?.done ?? "Set up here.";
};

/** Two results alike but for when they were checked, as the cache judges a change. */
const alike = (a: StepResult, b: StepResult): boolean => JSON.stringify({ ...a, checkedAt: null }) === JSON.stringify({ ...b, checkedAt: null });

export const scriptedSetup = (host: SetupHost): ScriptedSetupHandle & { readonly snapshot: () => readonly StepResult[] } => {
  const { clock, wire } = host;
  let script: Partial<Record<StepId, ScriptedStepResult | null>> = { ...host.script };
  /** The steps it gives a result for, in the checklist's order: each this build registers, and any other the script names. */
  const answered = (): StepId[] =>
    STEP_ORDER.filter((id) => script[id] !== null && (script[id] !== undefined || (REGISTERED_STEP_IDS as readonly string[]).includes(id)));
  const resultOf = (id: StepId): StepResult =>
    StepResult.parse({ step: id, state: "done", reason: doneReason(id), failing: [], actions: [], checkedAt: clock.now().toISOString(), ...script[id] });

  /** The results kept, as the environment's cache holds them: its start checked every step. */
  const kept = new Map<StepId, StepResult>(answered().map((id) => [id, resultOf(id)]));
  const check = (ids: readonly StepId[]): StepResult[] =>
    ids.map((id) => {
      const result = resultOf(id);
      const before = kept.get(id);
      kept.set(id, result);
      if (host.flagged && (before === undefined || !alike(before, result))) host.notice("setup.result-changed", { ...result });
      return result;
    });

  let held: (() => void)[] | null = null;
  let refused: FakeAnswer | null = null;
  wire.answer("setup.check", (params): FakeAnswer | Promise<FakeAnswer> => {
    if (refused !== null) return refused;
    const step = params["step"] as StepId | undefined;
    const answer = (): FakeAnswer => ({ result: { results: check(step === undefined ? answered() : answered().filter((id) => id === step)) } });
    if (held === null) return answer();
    const waiting = held;
    return new Promise((resolve) => waiting.push(() => resolve(answer())));
  });

  return {
    snapshot: () => answered().flatMap((id) => kept.get(id) ?? []),
    setSetup(changes) {
      script = { ...script, ...changes };
    },
    passSetup(steps) {
      check(steps === undefined ? answered() : answered().filter((id) => steps.includes(id)));
    },
    refuseSetupChecks(error) {
      refused = error === null ? null : { error };
    },
    holdSetupChecks() {
      held ??= [];
      return () => {
        const waiting = held ?? [];
        held = null;
        for (const release of waiting) release();
      };
    },
  };
};
