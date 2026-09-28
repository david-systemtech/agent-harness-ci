import { useObservable, useRuntime } from "../window-context.js";

/** What the sidebar calls the local environment before it has ever answered (#181). */
export const THIS_MACHINE = "This machine";

/**
 * The sidebar region (docs/specs/gui.md, "The window and the sidebar"): a
 * heading per environment the runtime knows, in its sequence, read from
 * `projections.environments`.
 */
export const SidebarRegion = () => {
  const environments = useObservable(useRuntime().projections.environments);
  return (
    <nav aria-label="Sessions" className="flex h-full flex-col gap-1 overflow-y-auto bg-inset p-3">
      {environments.map((environment) => (
        <h2 key={environment.environmentId} className="text-xs font-semibold text-ink-muted">
          {environment.name ?? THIS_MACHINE}
        </h2>
      ))}
    </nav>
  );
};
