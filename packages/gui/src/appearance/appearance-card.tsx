import { RESTORE_METHODS } from "@agent-harness/client-runtime";
import { readOnlyLine } from "../settings/generic-editor.js";
import { Part } from "../settings/part.js";
import { useSettingsValues } from "../settings/settings-values.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { EnvironmentTheme, LightOrDarkPreference } from "./theme-pane.js";

/**
 * The Appearance step's card (the Set up specification, "11. Appearance";
 * ADR 0023; #594): where the step stands, then its two parts. This
 * client's light, dark or the OS's, kept client-local at once and never
 * read-only, as on the Theme row (#418). Then the theme of the environment
 * the checklist checks, whose `appearance.contrast` the step is: its name,
 * each seed with its swatches in both ladders, and each seed the
 * derivation clamped, in the check's words. The picker arrives in phase D;
 * the step's Restore writes the preset theme through `settings.update`
 * (`restoreStep`), greyed without `admin`, whose line the card says once.
 * Done once set or preset, it asks for nothing until the check fails.
 */
export const AppearanceCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  const { values } = useSettingsValues(environmentId);
  const ready = view?.phase === "ready";
  const admin = runtime.capability(environmentId, RESTORE_METHODS.appearance);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      <Part title="This client">
        <LightOrDarkPreference />
      </Part>
      {view !== undefined && (
        <Part title="The environment's theme">
          {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
          {ready && admin.status === "absent" && <p className="text-sm text-amber">Read-only: {admin.message}</p>}
          <EnvironmentTheme view={view} />
        </Part>
      )}
    </>
  );
};
