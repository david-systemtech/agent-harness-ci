import { setupReachWords, type EnvironmentView, type ServiceFailure, type SetupView } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { Power, RotateCw } from "lucide-react";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { useLocalService } from "../connections/local-service.js";
import { Button, Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { SetupNotice } from "./notice.js";
import { useDetails } from "./use-details.js";

/**
 * This computer's service started from one place in Set up (the reach line,
 * or a step's `start-service`): `start`, whether one is under way, and why
 * the last one asked from here did not start, so the place that asked says
 * it and no other.
 */
export const useStart = () => {
  const service = useLocalService();
  const [asked, setAsked] = useState(false);
  return {
    start: (environmentId: string) => {
      setAsked(true);
      service.start(environmentId);
    },
    failure: asked && !service.starting ? service.failure : undefined,
  };
};

/** A start that did not start the service on `name` (setup-copy.md §3, the patterns): what to do, and the failure under Details. */
export const StartFailed = ({ name, failure }: { readonly name: string; readonly failure: ServiceFailure }) => {
  const details = useDetails();
  const title = `${PRODUCT_NAME} did not start on ${name}.`;
  const description = "Choose Start to try again.";
  return <SetupNotice tone="error" title={title} description={description} details={details({ computer: { name }, line: `${title} ${description}`, details: [failure.text] })} />;
};

/**
 * Why the checklist's results are not known to hold now, from the client's
 * own connection (the Set up specification, "Running checks"; setup-copy.md
 * §3, the patterns): unreachable since when, with Try again, which makes the
 * connection's attempt again now; or, for this machine's environment with
 * its service down, that it is not running, with Start (`start-service`),
 * and a start that did not start said with its failure under Details.
 * Nothing while it can be reached.
 */
export const ReachLine = ({ view, environment }: { readonly view: SetupView; readonly environment: EnvironmentView }) => {
  const runtime = useRuntime();
  const service = useLocalService();
  const { start, failure } = useStart();
  const name = nameOf(environment);
  const words = setupReachWords(view.reach, name);
  if (words === undefined) return null;
  return (
    <div data-reach-line className="flex flex-col gap-2 border-b border-line px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-amber">
        <span>{words}</span>
        {view.reach.status === "service-down" && service.available.status === "present" && (
          <Tooltip content="Start" keys="Tab, Enter">
            <Button disabled={service.starting} onClick={() => start(view.environmentId)}>
              <Power aria-hidden="true" />{service.starting ? "Starting…" : "Start"}
            </Button>
          </Tooltip>
        )}
        {view.reach.status === "unreachable" && (
          <Tooltip content="Try again" keys="Tab, Enter">
            <Button onClick={() => void runtime.connections.retryNow(view.environmentId).catch(() => undefined)}>
              <RotateCw aria-hidden="true" />Try again
            </Button>
          </Tooltip>
        )}
      </div>
      {view.reach.status === "service-down" && failure !== undefined && <StartFailed name={name} failure={failure} />}
    </div>
  );
};
