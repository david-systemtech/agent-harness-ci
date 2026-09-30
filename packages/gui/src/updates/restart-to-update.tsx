import type { DesktopBuildView } from "@agent-harness/client-runtime";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** Whether a restart would update: a build is staged, ready, or left to apply after a failed step. */
const restartable = (build: DesktopBuildView): boolean => build.state === "ready" || (build.state === "failed" && build.staged !== null);

/**
 * "Restart to update" (launcher-update spec, "The desktop moves with its
 * local environment"; #424): once the runtime reports a desktop build its
 * local environment staged, a click applies it now through the shell
 * (`desktopUpdate.restart`). Nothing otherwise.
 */
export const RestartButton = () => {
  const runtime = useRuntime();
  const { build } = useObservable(runtime.desktopUpdate.view);
  if (!restartable(build)) return null;
  return (
    <Button tone="primary" onClick={() => void runtime.desktopUpdate.restart()}>
      Restart to update
    </Button>
  );
};

/** The header's "Restart to update": the button once a build is staged, and while it applies, that it restarts. */
export const RestartToUpdate = () => {
  const runtime = useRuntime();
  const { build } = useObservable(runtime.desktopUpdate.view);
  return build.state === "applying" ? <span className="text-xs text-ink-muted">Restarting to update…</span> : <RestartButton />;
};
