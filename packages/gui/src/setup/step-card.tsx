import { SETUP_ACTION_WORDS, lastGoodWords, planSetupAction, restoreStep, stepLine, uuidv7, type SetupActionPlan, type SetupStepView } from "@agent-harness/client-runtime";
import { STEP_ORDER, settingsRow } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { useLocalService } from "../connections/local-service.js";
import { useSettings } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { useChecklist } from "./checklist-window.js";
import { HealthDot } from "./health-dot.js";

/**
 * Carries out a named action on the environment checked (`planSetupAction`):
 * `setup.check`, the step's restore and its check again, the local
 * service's start, the checklist switched to another environment, or a row
 * of Settings, which leaves the full checklist. What a restore did is said
 * through `say`.
 */
const useSetupActions = (environmentId: string, say: (line: string) => void) => {
  const runtime = useRuntime();
  const clock = useClock();
  const service = useLocalService();
  const { pick } = useSettings();
  const { leave } = useChecklist();
  return async (plan: SetupActionPlan): Promise<void> => {
    switch (plan.kind) {
      case "check":
        return void runtime.setup.check(environmentId, plan.step);
      case "restore": {
        const restored = await restoreStep(runtime, environmentId, plan.step, uuidv7(clock.now()));
        say(restored.line);
        if (restored.ok) void runtime.setup.check(environmentId, plan.step);
        return;
      }
      case "start-service":
        return service.start(environmentId);
      case "pick":
        return pick(plan.environmentId);
      case "row":
        return leave(plan.row, environmentId);
    }
  };
};

/**
 * A step's card in the full checklist (docs/specs/gui.md, "Set up in the
 * window"), until #88 fills each with its own: its state and line (pending,
 * aged, the last good result beneath one that could not check), its named
 * actions, Check now where Check again is not among them (a check of the
 * step, or of every step for one this build cannot ask about alone), a link
 * to its home row, and Continue to the next step, or Finish on the last,
 * which sets the first-launch mark.
 */
export const StepCard = ({ environmentId, step }: { readonly environmentId: string; readonly step: SetupStepView }) => {
  const runtime = useRuntime();
  const { choose, close, leave } = useChecklist();
  const heading = useId();
  const [line, say] = useState<string | undefined>(undefined);
  const act = useSetupActions(environmentId, say);
  const next = STEP_ORDER[STEP_ORDER.indexOf(step.id) + 1];
  const { result } = step;
  const actions = result?.actions ?? [];
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
        {actions.map((action) => (
          <Button key={action} tone="primary" onClick={() => void act(planSetupAction(step, action, result?.targets))}>
            {SETUP_ACTION_WORDS[action]}
          </Button>
        ))}
        {!actions.includes("check-again") && <Button onClick={() => void act(planSetupAction(step, "check-again"))}>Check now</Button>}
        <Button onClick={() => leave(step.home, environmentId)}>Open {settingsRow(step.home).label}</Button>
      </div>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      <div className="mt-auto flex justify-end gap-2">
        {next === undefined ? (
          <Button tone="primary" onClick={close}>
            Finish
          </Button>
        ) : (
          <>
            {step.skippable && <Button onClick={() => choose(next)}>Skip for now</Button>}
            <Button tone="primary" onClick={() => choose(next)}>
              Continue
            </Button>
          </>
        )}
      </div>
    </section>
  );
};
