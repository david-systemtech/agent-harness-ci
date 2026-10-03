import type { EnvironmentView } from "@agent-harness/client-runtime";
import { useLocalService } from "./local-service.js";
import { Remedy } from "./remedy.js";
import { RunHereSwitch } from "./run-here.js";
import { phaseSentence } from "./words.js";

/**
 * This machine's environment while the window waits on it
 * (docs/specs/gui.md, "The local environment, pairing and updates"): its
 * phase from service down through starting to ready, in one line; why a
 * start failed; and what it offers (start it, try again).
 */
export const LocalEnvironmentPane = ({ view }: { readonly view: EnvironmentView }) => {
  const service = useLocalService();
  const failed = view.phase === "service-down" && !service.starting && service.failure !== undefined;
  return (
    <section aria-label="This machine" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-base font-semibold text-ink">{view.name ?? "This machine"}</h2>
      <p role="status" className="max-w-xl text-sm text-ink-muted">
        {failed ? `The environment on this machine did not start: ${service.failure}` : phaseSentence(view, service.starting, service.installing)}
      </p>
      <Remedy view={view} startLabel={failed ? "Try again" : "Start it"} />
      <RunHereSwitch />
    </section>
  );
};
