import { Part } from "../settings/part.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { LightOrDarkPreference } from "./theme-pane.js";
import { ThemePicker } from "./theme-picker.js";

/**
 * The Appearance step's card (the Set up specification, "11. Appearance";
 * ADR 0023; #594): where the step stands, then its two parts. This
 * client's light, dark or the OS's, kept client-local at once and never
 * read-only, as on the Theme row (#418). Then the theme of the environment
 * the checklist checks, whose `appearance.contrast` the step is, in the
 * theme picker the Theme row shares (#1194): its name, each seed with its
 * swatches in both ladders, each seed the derivation clamped in the check's
 * words, and the candidate a person makes and saves to that environment.
 * The step's Restore writes the preset theme through `settings.update`
 * (`restoreStep`), greyed without `admin`, whose line the picker says once.
 * Done once set or preset, it asks for nothing until the check fails.
 */
export const AppearanceCard = ({ environmentId, step }: StepCardProps) => {
  const view = useObservable(useRuntime().projections.environments).find((environment) => environment.environmentId === environmentId);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      <Part title="This client">
        <LightOrDarkPreference />
      </Part>
      {view !== undefined && (
        <Part title="The environment's theme">
          <ThemePicker key={view.environmentId} view={view} />
        </Part>
      )}
    </>
  );
};
