import { useClock } from "../window-context.js";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { useLocalService } from "./local-service.js";
import { Remedy } from "./remedy.js";
import { ImmediateUpdate } from "./update-progress.js";
import { phaseWords } from "./words.js";

/** Under an environment's sidebar heading: its phase while it is not ready, a block with its action, and what it offers. */
export const EnvironmentStatus = ({ view }: { readonly view: EnvironmentView }) => {
  const clock = useClock();
  const { starting, installing } = useLocalService();
  const words = phaseWords(view, starting && view.kind === "local", installing && view.kind === "local", clock.now());
  if (words === undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <span>{words}</span>
      <Remedy view={view} />
      <ImmediateUpdate view={view} />
    </div>
  );
};
