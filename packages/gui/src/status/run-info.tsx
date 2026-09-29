import { endWords, formatTokens, formatUsd, identityWords, spendOf } from "@agent-harness/client-runtime";
import type { RunPolicy, RunSummary } from "@agent-harness/contracts";
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
 * `app.runInfo.toggle`, Mod+I; #402): the session's latest run, with its
 * resolved policy (who started it, attended or not, its mode and
 * containment as the environment resolved them, from `run.policy.resolved`;
 * the mode from the run's own record when that was not heard), its account,
 * model and effort, its tokens and cost, and how it ended. Opened from its
 * button at the end of the status line or by its keys, closed by them again
 * or by Esc.
 */
export const RunInfo = ({ environmentId, sessionId }: RunInfoProps) => {
  const [open, setOpen] = useState(false);
  useKeyAction("app.runInfo.toggle", () => setOpen((shown) => !shown));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="ml-auto h-6 shrink-0 px-2 text-xs font-normal text-ink-muted">Run info</Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" aria-label="Run info" className="w-96">
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
  if (run === undefined) return <p className="text-ink-faint">No run yet: the session's first message starts one.</p>;
  const policy = projection.policies[run.runId];
  const account = accounts.value?.find((candidate) => candidate.id === run.accountId);
  const spend = spendOf(run.usage);
  return (
    <section aria-label="The latest run" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">The latest run</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Fact term="Started by">{policy ? startedBy(policy) : run.origin}</Fact>
        <Fact term="Account">{account ? `${account.label} (${identityWords(account)})` : run.accountId}</Fact>
        <Fact term="Model">{run.model}</Fact>
        <Fact term="Effort">{run.effort ?? "the model's own"}</Fact>
        <Fact term="Mode">{modeWords(run, policy)}</Fact>
        <Fact term="Containment">{policy ? containmentWords(policy) : "not heard by this window: the run's policy was resolved before it caught up"}</Fact>
        <Fact term="Tokens">{spend ? `${formatTokens(spend.tokens)} (${usageWords(run)})` : "none reported yet"}</Fact>
        <Fact term="Cost">{spend?.costUsd != null ? formatUsd(spend.costUsd) : "not reported"}</Fact>
        <Fact term="Ending">{endingWords(run)}</Fact>
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

/** Who started the run, and whether a person was there. */
const startedBy = (policy: RunPolicy): string => {
  const who = policy.actorName !== null ? `${policy.actorKind} ${policy.actorName}` : policy.actorKind;
  return `${who}, ${policy.attended ? "attended" : "unattended"}${policy.unattendedDefaultApplied ? " (the unattended default mode)" : ""}`;
};

/** The mode the run got, and the clamp when it was lowered: the resolved policy's reason and ceiling when heard, the run's own record otherwise. */
const modeWords = (run: RunSummary, policy: RunPolicy | undefined): string => {
  if (policy) {
    const { mode } = policy;
    if (!mode.clamped) return `${mode.effective}${mode.requested === null ? " (the default)" : ""}, under the ceiling ${mode.ceiling}`;
    return mode.clampReason === "unavailable"
      ? `${mode.effective}, clamped from ${mode.requested ?? "the default"}: its account cannot use it`
      : `${mode.effective}, clamped from ${mode.requested ?? "the default"} to the ceiling ${mode.ceiling}`;
  }
  return run.mode.clamped ? `${run.mode.effective}, clamped from ${run.mode.requested ?? "the default"}` : run.mode.effective;
};

/** The containment the run got, what enforces it, and why it is not the level asked for when it is not. */
const containmentWords = ({ containment }: RunPolicy): string => {
  const asked = containment.requested === null ? "the environment's default" : `asked for ${containment.requested}`;
  const by = containment.mechanism === null ? "" : `, enforced by ${containment.mechanism}`;
  return `${containment.effective} (${asked})${by}${containment.reason !== null ? `: ${containment.reason}` : ""}`;
};

/** The run's tokens by kind: input, cache reads and writes, output. */
const usageWords = (run: RunSummary): string => {
  const sum = (pick: (model: NonNullable<RunSummary["usage"]>[number]) => number) => (run.usage ?? []).reduce((total, model) => total + pick(model), 0);
  return `${formatTokens(sum((m) => m.inputTokens))} in, ${formatTokens(sum((m) => m.cacheReadTokens))} cache read, ${formatTokens(sum((m) => m.cacheWriteTokens))} cache write, ${formatTokens(sum((m) => m.outputTokens))} out`;
};

/** How the run ended: still running, completed, or its end in words with the error it ended on. */
const endingWords = (run: RunSummary): string => {
  if (run.state === "running") return "still running";
  const words = endWords(run);
  return run.error !== null ? `${words}: ${run.error.message}` : words;
};
