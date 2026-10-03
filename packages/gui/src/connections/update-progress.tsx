import type { EnvironmentView } from "@agent-harness/client-runtime";
import { useState } from "react";
import { Button } from "../ui/index.js";
import { useRuntime, useClock } from "../window-context.js";
import { updateWords } from "./words.js";

/** The local idle hold can be advanced through the installed CLI even when the wire is blocked. */
export const ImmediateUpdate = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return <>
    {view.update?.canUpdateNow && <Button disabled={asking} onClick={() => {
      setAsking(true);
      setError(undefined);
      void runtime.connections.updateEnvironmentNow(view.environmentId)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setAsking(false));
    }}>Update immediately</Button>}
    {error !== undefined && <span role="status" className="text-signal">Not updated: {error}</span>}
  </>;
};

export const UpdateProgress = ({ view }: { readonly view: EnvironmentView }) => {
  const words = updateWords(view, useClock().now());
  if (words === undefined) return null;
  return <div className="flex flex-col items-start gap-2 text-xs text-ink-muted">
    <p role="status">{words}</p>
    <ImmediateUpdate view={view} />
  </div>;
};
