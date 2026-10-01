import { useObservable, useRuntime } from "../window-context.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { InstructionsContent } from "./instructions-pane.js";

/** Set up shares the Instructions pane's controls; only opening this card seeds the Setup note. */
export const InstructionsCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      {view !== undefined && <InstructionsContent key={environmentId} view={view} setup />}
    </>
  );
};
