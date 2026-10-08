import { contextOf, type ContextFacts } from "@agent-harness/client-runtime";
import { CircleGauge } from "lucide-react";
import { useMemo } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";

/** The context ring reads the same runtime facts on the live stream and a restored snapshot. */
export const SessionContextMeter = ({ environmentId, sessionId, accountId, model }: {
  readonly environmentId: string; readonly sessionId: string; readonly accountId: string | null; readonly model: string | null;
}) => {
  const runtime = useRuntime();
  const session = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
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
  const value = facts.percent === null ? "—" : String(facts.percent);
  const tone = facts.percent === null ? "text-ink-faint" : facts.percent >= 90 ? "text-signal" : facts.percent >= 75 ? "text-amber" : "text-sage";
  const detail = facts.tokens === null ? "Context reading unknown" : facts.window === null ? `${facts.tokens.toLocaleString("en-US")} tokens · unknown scale` : `${facts.tokens.toLocaleString("en-US")} / ${facts.window.toLocaleString("en-US")} tokens`;
  return (
    <Popover>
      <Tooltip content={`Context usage: ${detail}`}>
        <PopoverTrigger asChild>
          <Button aria-label="Context usage" className="h-6 min-w-0 shrink gap-1 px-1 text-xs font-normal [&_svg]:size-6">
            <span className="min-w-0 truncate">Context</span>
            <svg role="img" aria-label={`Context: ${facts.percent === null ? "unknown" : `${facts.percent}%`}`} viewBox="0 0 36 36" className={`h-6 w-6 shrink-0 ${tone}`}>
              <circle cx="18" cy="18" r="16" fill="currentColor" fillOpacity="0.12" />
              <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
              <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="4" pathLength="100" strokeDasharray={`${facts.percent ?? 0} 100`} transform="rotate(-90 18 18)" className="transition-[stroke-dasharray] duration-300" />
              <text x="18" y="18" textAnchor="middle" dominantBaseline="central" fill="currentColor" fontSize={facts.percent === 100 ? 8 : 9}>{value}</text>
            </svg>
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
