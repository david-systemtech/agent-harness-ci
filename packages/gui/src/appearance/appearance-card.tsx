import { Part } from "../settings/part.js";
import type { StepCardProps } from "../setup/cards.js";
import { checkSetup } from "../setup/use-setup.js";
import { StepStatus } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { LightOrDarkPreference } from "./theme-pane.js";
import { ThemePicker } from "./theme-picker.js";

/** setup-copy.md §5.13: device-local light or dark, then the checked environment's theme.
 * The picker confirms before replacing colours and keeps settings reads current after a write.
 * It handles the check's restore in place, so the status never offers an immediate reset.
 */
export const AppearanceCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  return (
    <>
      <LightOrDarkPreference />
      {view !== undefined && (
        <Part title="Theme">
          <ThemePicker key={view.environmentId} view={view} showStatus={false} onSaved={() => void checkSetup(runtime, environmentId, "appearance")} />
        </Part>
      )}
      <StepStatus environmentId={environmentId} step={step} handledActions={["restore"]} />
    </>
  );
};
