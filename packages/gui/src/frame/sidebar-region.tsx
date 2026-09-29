import { EnvironmentStatus } from "../connections/environment-status.js";
import { useOpenPairing } from "../connections/pairing.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** What the sidebar calls the local environment before it has ever answered (#181). */
export const THIS_MACHINE = "This machine";

/**
 * The sidebar region (docs/specs/gui.md, "The window and the sidebar"): a
 * heading per environment the runtime knows, in its sequence, read from
 * `projections.environments`, each with its connection's phase and what it
 * offers while it is not ready, and pairing with another environment.
 */
export const SidebarRegion = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const openPairing = useOpenPairing();
  return (
    <nav aria-label="Sessions" className="flex h-full flex-col gap-1 overflow-y-auto bg-inset p-3">
      {environments.map((environment) => (
        <div key={environment.environmentId} className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold text-ink-muted">{environment.name ?? THIS_MACHINE}</h2>
          <EnvironmentStatus view={environment} />
        </div>
      ))}
      <Button className="mt-auto self-start" onClick={() => openPairing()}>
        Pair with an environment…
      </Button>
    </nav>
  );
};
