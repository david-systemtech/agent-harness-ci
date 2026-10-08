import { Monitor } from "lucide-react";
import { Switch, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { useLocalService } from "./local-service.js";

/**
 * "Run agent-harness on this computer" (docs/specs/gui.md, "The local
 * environment, pairing and updates"), the window's presentation preset on:
 * turned off, the window opens on pairing; turned on, it starts this
 * machine's environment when its service is down.
 */
export const RunHereSwitch = () => {
  const [runHere, setRunHere] = usePresentation("runLocalEnvironment");
  const environments = useObservable(useRuntime().projections.environments);
  const service = useLocalService();
  const change = (on: boolean) => {
    setRunHere(on);
    const local = environments.find((view) => view.kind === "local");
    if (on && local?.phase === "service-down" && service.available.status === "present" && !service.starting) service.start(local.environmentId);
  };
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <Tooltip content="Run agent-harness on this computer"><Switch checked={runHere} onCheckedChange={change} aria-label="Run agent-harness on this computer" /></Tooltip>
      <Monitor aria-hidden="true" className="size-4 shrink-0" />
      <span>Run agent-harness on this computer</span>
    </label>
  );
};
