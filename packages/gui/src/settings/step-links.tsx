import { STEP_LABELS, type StepId } from "@agent-harness/contracts";
import { useChecklist } from "../setup/checklist-window.js";
import { Button } from "../ui/index.js";

/** A link to each step given, which opens the full checklist on that step's card (#413); nothing for none. */
export const StepLinks = ({ steps }: { readonly steps: readonly StepId[] }) => {
  const { open } = useChecklist();
  return steps.length === 0 ? null : (
    <div className="flex flex-wrap gap-2">
      {steps.map((step) => (
        <Button key={step} onClick={() => open(step)}>
          Open the {STEP_LABELS[step]} step in Set up
        </Button>
      ))}
    </div>
  );
};
