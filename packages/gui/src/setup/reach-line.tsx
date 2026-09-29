import { setupReachWords, type EnvironmentView, type SetupView } from "@agent-harness/client-runtime";
import { nameOf } from "../connections/words.js";
import { useLocalService } from "../connections/local-service.js";
import { Button } from "../ui/index.js";

/**
 * Why the checklist's results are not known to hold now, from the client's
 * own connection (the Set up specification, "Running checks"): unreachable
 * since when, or, for this machine's environment with its service down, that
 * it is not running, with Start (`start-service`); nothing while it can be
 * reached.
 */
export const ReachLine = ({ view, environment }: { readonly view: SetupView; readonly environment: EnvironmentView }) => {
  const service = useLocalService();
  const words = setupReachWords(view.reach, nameOf(environment));
  if (words === undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm text-amber">
      <span>{words}</span>
      {view.reach.status === "service-down" && service.available.status === "present" && (
        <Button disabled={service.starting} onClick={() => service.start(view.environmentId)}>
          {service.starting ? "Starting…" : "Start"}
        </Button>
      )}
    </div>
  );
};
