import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { useObservable, useRuntime } from "../window-context.js";
import { usePickedEnvironment, useSettings } from "./settings-window.js";

/**
 * The environment picker in an `environment` row's header (ADR 0027): every
 * environment the window knows, in the saved sequence, preset to the home
 * environment and following the last choice for the life of the window, so
 * the pane always names the machine it edits.
 */
export const EnvironmentPicker = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const picked = usePickedEnvironment();
  const { pick } = useSettings();
  return (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      Environment
      <select
        value={picked?.environmentId ?? ""}
        onChange={(event) => pick(event.target.value)}
        className="h-8 rounded-md border border-line bg-inset px-2 text-sm text-ink outline-none focus-visible:border-beam"
      >
        {environments.map((view) => (
          <option key={view.environmentId} value={view.environmentId}>
            {view.name ?? THIS_MACHINE}
          </option>
        ))}
      </select>
    </label>
  );
};
