import { useId } from "react";
import { EnvironmentPicker } from "../settings/environment-picker.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { classes } from "../ui/classes.js";
import { Button } from "../ui/index.js";
import { useChecklist } from "./checklist-window.js";
import { HealthDot } from "./health-dot.js";
import { ReachLine } from "./reach-line.js";
import { StepCard } from "./step-card.js";
import { useCheckOnOpen, useSetupView } from "./use-setup.js";

/**
 * Set up as the whole window (docs/specs/gui.md, "Set up in the window";
 * ADR 0016): the environment it checks with a picker (the one the last
 * `environment` pane picked, else the home environment) and Close across the
 * top, the eleven steps on a rail with their dots, and the chosen step's
 * card beside it. Opening it, or pointing it at another environment, checks
 * every step there.
 */
export const ChecklistView = () => {
  const { step: shown, choose, close } = useChecklist();
  const picked = usePickedEnvironment();
  const view = useSetupView(picked?.environmentId);
  useCheckOnOpen(picked?.environmentId);
  const heading = useId();
  const step = view?.steps.find((candidate) => candidate.id === shown);
  return (
    <section aria-labelledby={heading} className="flex h-dvh flex-col bg-abyss text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-line bg-panel px-4 py-2">
        <h1 id={heading} className="text-base font-semibold text-ink">
          Set up
        </h1>
        <EnvironmentPicker />
        <Button aria-label="Close Set up" className="ml-auto" onClick={close}>
          Close
        </Button>
      </header>
      {view !== undefined && picked !== undefined && <ReachLine view={view} environment={picked} />}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Set up steps" className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-inset p-3">
          <ol className="flex flex-col gap-0.5">
            {view?.steps.map((candidate) => (
              <li key={candidate.id} className="flex items-center gap-2">
                <button
                  type="button"
                  aria-current={candidate.id === shown ? "step" : undefined}
                  onClick={() => choose(candidate.id)}
                  className={classes(
                    "flex-1 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
                    candidate.id === shown ? "bg-wash-strong" : undefined,
                    // A step the environment does not register is dim, with no dot.
                    !candidate.registered ? "text-ink-faint" : candidate.id === shown ? "text-ink" : "text-ink-muted",
                  )}
                >
                  {candidate.label}
                </button>
                <HealthDot state={candidate.result?.state ?? null} of={candidate.label} />
              </li>
            ))}
          </ol>
        </nav>
        {step !== undefined && picked !== undefined && <StepCard key={`${picked.environmentId} ${step.id}`} environmentId={picked.environmentId} step={step} />}
      </div>
    </section>
  );
};
