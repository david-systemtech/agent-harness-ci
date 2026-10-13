import { contextOf, type ContextFacts, type SessionProjection } from "@agent-harness/client-runtime";
import { CircleGauge } from "lucide-react";
import { useMemo } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useObservableSelector, useRuntime } from "../window-context.js";
import { UsageRing } from "./window-reading.js";

const contextFields = (projection: SessionProjection) => ({ runs: projection.runs });

/** The context ring reads the same runtime facts on the live stream and a restored snapshot. */
export const SessionContextMeter = ({ environmentId, sessionId, accountId, model }: {
  readonly environmentId: string; readonly sessionId: string; readonly accountId: string | null; readonly model: string | null;
}) => {
  const runtime = useRuntime();
  const session = useObservableSelector(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]), contextFields);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const providers = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "providers.list", {}), [runtime, environmentId]));
  const actualAccount = session.runs.at(-1)?.accountId ?? accountId;
  const providerId = accounts.value?.find((entry) => entry.id === actualAccount)?.provider;
  const provider = providers?.result?.providers.find((entry) => entry.provider === providerId);
  const facts = contextOf({
    supported: provider?.contextReadings === true, runs: session.runs, accountId: actualAccount, model,
    models: catalogues.value?.find((entry) => entry.accountId === actualAccount)?.models ?? [],
  });
  return <ContextMeter facts={facts} />;
};

/** A current context ring. Unknown input and unknown scale both keep the arc empty. */
export const ContextMeter = ({ facts }: { readonly facts: ContextFacts }) => {
  if (!facts.supported) return null;
  const detail = facts.tokens === null ? "Context reading unknown" : facts.window === null ? `${facts.tokens.toLocaleString("en-US")} tokens · unknown scale` : `${facts.tokens.toLocaleString("en-US")} / ${facts.window.toLocaleString("en-US")} tokens`;
  return (
    <Popover>
      <Tooltip content={`Context usage: ${detail}`}>
        <PopoverTrigger asChild>
          <Button aria-label="Context usage" className="h-6 min-w-0 shrink gap-1 px-1 text-xs font-normal [&_svg]:size-6">
            <span className="min-w-0 truncate">Context</span>
            <UsageRing reading={{
              window: "context", label: "Context:", value: facts.percent === null ? "unknown" : `${facts.percent}%`,
              utilisation: facts.percent === null ? null : facts.percent / 100, pressure: undefined, resetsAt: null,
            }} />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-72 p-3" aria-label="Context usage details">
        <p className="flex items-center gap-1 text-xs font-medium"><CircleGauge size={12} aria-hidden="true" />Current context</p>
        <p className="text-xs text-ink-muted">{facts.model ?? "Model unknown"}</p>
        <p className="text-xs">{detail}</p>
      </PopoverContent>
    </Popover>
  );
};
