import { Laptop } from "lucide-react";
import { EnvironmentMark } from "../connections/environment-mark.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { useObservable, useRuntime } from "../window-context.js";
import { usePickedEnvironment, useSettings } from "./settings-window.js";

/**
 * The environment picker in an `environment` row's header (ADR 0027): every
 * environment the window knows, in the saved sequence, preset to the home
 * environment and following the last choice for the life of the window, so
 * the pane always names the machine it edits. Set up's header names it by
 * what it does there, "Setting up:" (setup-copy.md §4.4).
 */
export const EnvironmentPicker = ({ label = "Environment" }: { readonly label?: string }) => {
  const environments = useObservable(useRuntime().projections.environments);
  const picked = usePickedEnvironment();
  const { pick } = useSettings();
  return (
    <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-ink-muted">
      <Laptop aria-hidden="true" className="size-4 shrink-0" />
      {label}
      {picked !== undefined && <EnvironmentMark view={picked} />}
      <select
        aria-label={label.replace(/:$/, "")}
        title="Choose environment · Arrow keys"
        value={picked?.environmentId ?? ""}
        onChange={(event) => pick(event.target.value)}
        className="h-8 min-w-0 max-w-full rounded-md border border-hairline bg-inset px-2 text-xs text-ink outline-none focus-visible:border-beam"
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
