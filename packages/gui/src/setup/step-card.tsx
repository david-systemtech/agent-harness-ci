import { lastGoodWords, stepLine, type SetupStepView } from "@agent-harness/client-runtime";
import { REGISTERED_STEP_IDS, STEP_ORDER, settingsRow, type RegisteredStepId, type StepId } from "@agent-harness/contracts";
import { useId } from "react";
import { Button } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useChecklist } from "./checklist-window.js";
import { HealthDot } from "./health-dot.js";

/** Whether this build can ask the environment to check `step` alone (`setup.check`'s `step` names a registered step). */
export const isRegisteredStep = (step: StepId): step is RegisteredStepId => (REGISTERED_STEP_IDS as readonly StepId[]).includes(step);

/**
 * A step's card in the full checklist (docs/specs/gui.md, "Set up in the
 * window"), until #88 fills each with its own: its state and line (pending,
 * aged, the last good result beneath one that could not check), Check now,
 * a link to its home row, and Continue to the next step, or Finish on the
 * last, which sets the first-launch mark.
 */
export const StepCard = ({ environmentId, step }: { readonly environmentId: string; readonly step: SetupStepView }) => {
  const runtime = useRuntime();
  const { choose, close, leave } = useChecklist();
  const heading = useId();
  const next = STEP_ORDER[STEP_ORDER.indexOf(step.id) + 1];
  const { result } = step;
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center gap-2">
        <h2 id={heading} className="text-lg font-semibold text-ink">
          {step.label}
        </h2>
        <HealthDot state={result?.state ?? null} of={step.label} />
      </header>
      <p className="text-sm text-ink">{stepLine(step)}</p>
      {result?.lastGood !== undefined && <p className="text-sm text-ink-muted">{lastGoodWords(result.lastGood, runtime.environmentNow(environmentId))}</p>}
      <div className="flex flex-wrap gap-2">
        {isRegisteredStep(step.id) && <Button onClick={() => void runtime.setup.check(environmentId, step.id as RegisteredStepId)}>Check now</Button>}
        <Button onClick={() => leave(step.home, environmentId)}>Open {settingsRow(step.home).label}</Button>
      </div>
      <div className="mt-auto flex justify-end">
        {next === undefined ? (
          <Button tone="primary" onClick={close}>
            Finish
          </Button>
        ) : (
          <Button tone="primary" onClick={() => choose(next)}>
            Continue
          </Button>
        )}
      </div>
    </section>
  );
};
