import { STEP_ORDER } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { Button } from "../ui/index.js";
import { useRegisteredCard, type StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { ContinueHoldContext } from "./continue-hold.js";
import { HealthDot } from "./health-dot.js";
import { StepStatus } from "./step-status.js";

/**
 * A step's card in the full checklist (docs/specs/gui.md, "Set up in the
 * window"): the step's name and dot, then the card registered for the step
 * (`cards.ts`), else the fallback card, which is where the step stands
 * and nothing more (`StepStatus`), then the checklist's way on:
 * Continue to the next step, beside it Skip for now on a step that may be
 * skipped, which moves on and records nothing (the Set up specification,
 * "Skipped"), or Finish on the last, which sets the first-launch mark.
 * A card may hold Continue (`useHoldContinue`): it is greyed, with the
 * card's line beside it, until the card lets it go.
 */
export const StepCard = ({ environmentId, step }: StepCardProps) => {
  const { choose, close } = useChecklist();
  const heading = useId();
  const Card = useRegisteredCard(step.id) ?? StepStatus;
  const next = STEP_ORDER[STEP_ORDER.indexOf(step.id) + 1];
  const [held, hold] = useState<string | undefined>(undefined);
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center gap-2">
        <h2 id={heading} className="text-lg font-semibold text-ink">
          {step.label}
        </h2>
        <HealthDot state={step.result?.state ?? null} of={step.label} />
      </header>
      <ContinueHoldContext value={hold}>
        <Card environmentId={environmentId} step={step} />
      </ContinueHoldContext>
      <div className="mt-auto flex items-center justify-end gap-2">
        {next === undefined ? (
          <Button tone="primary" onClick={close}>
            Finish
          </Button>
        ) : (
          <>
            {held !== undefined && <p className="text-sm text-ink-muted">{held}</p>}
            {step.skippable && <Button onClick={() => choose(next)}>Skip for now</Button>}
            <Button tone="primary" disabled={held !== undefined} onClick={() => choose(next)}>
              Continue
            </Button>
          </>
        )}
      </div>
    </section>
  );
};
