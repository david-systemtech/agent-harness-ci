import { NO_RUN_YET, runInfoFacts } from "@agent-harness/client-runtime";
import { useMemo, useState, type ReactNode } from "react";
import { useKeyAction } from "../keys/key-dispatch.js";
import { Button, Popover, PopoverContent, PopoverTrigger } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

export interface RunInfoProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/**
 * Run info (docs/specs/gui.md, "A session pane": the caption's run info;
 * `app.runInfo.toggle`, Mod+I; #402, in the caption since #407): the session's latest run, with its
 * resolved policy (who started it, attended or not, its mode and
 * containment as the environment resolved them, from `run.policy.resolved`;
 * the mode from the run's own record when that was not heard), its account,
 * model and effort, its tokens and cost, and how it ended. Opened from its
 * button in the pane's caption or by its keys, closed by them again or by
 * Esc.
 */
export const RunInfo = ({ environmentId, sessionId }: RunInfoProps) => {
  const [open, setOpen] = useState(false);
  useKeyAction("app.runInfo.toggle", () => setOpen((shown) => !shown));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="ml-auto h-6 shrink-0 px-2 text-xs font-normal text-ink-muted">Run info</Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" aria-label="Run info" className="w-96">
        <LatestRun environmentId={environmentId} sessionId={sessionId} />
      </PopoverContent>
    </Popover>
  );
};

const LatestRun = ({ environmentId, sessionId }: RunInfoProps) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const run = projection.runs.at(-1);
  if (run === undefined) return <p className="text-ink-faint">{NO_RUN_YET}</p>;
  const policy = projection.policies[run.runId];
  const account = accounts.value?.find((candidate) => candidate.id === run.accountId);
  return (
    <section aria-label="The latest run" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">The latest run</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {runInfoFacts(run, policy, account).map(({ term, words }) => <Fact key={term} term={term}>{words}</Fact>)}
      </dl>
    </section>
  );
};

const Fact = ({ term, children }: { readonly term: string; readonly children: ReactNode }) => (
  <>
    <dt className="text-ink-faint">{term}</dt>
    <dd className="text-ink">{children}</dd>
  </>
);
