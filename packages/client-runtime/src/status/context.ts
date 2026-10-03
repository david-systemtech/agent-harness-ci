import type { ModelEntry, RunSummary } from "@agent-harness/contracts";

export interface ContextFacts {
  readonly supported: boolean;
  readonly model: string | null;
  readonly tokens: number | null;
  readonly window: number | null;
  readonly percent: number | null;
}

/** Current main request context. A denominator is learned only from a provider reading for that model. */
export const contextOf = (input: {
  readonly supported: boolean;
  readonly runs: readonly RunSummary[];
  readonly model: string | null;
  readonly accountId: string | null;
  readonly models: readonly ModelEntry[];
}): ContextFacts => {
  const latest = input.runs.at(-1);
  const model = latest?.context?.model ?? latest?.model ?? input.model;
  if (!input.supported) return { supported: false, model, tokens: null, window: null, percent: null };
  const accountId = latest?.accountId ?? input.accountId;
  let window = input.models.find((entry) => entry.id === model)?.contextWindow ?? null;
  for (const run of input.runs) {
    if (run.accountId !== accountId) continue;
    const learned = model !== null && run.contextWindows !== undefined && Object.hasOwn(run.contextWindows, model) ? run.contextWindows[model] : undefined;
    if (learned !== undefined) window = learned;
    const reported = run.usage?.find((entry) => entry.model === model)?.contextWindow;
    if (reported != null) window = reported;
    if (run.context?.model === model && run.context.contextWindow !== null) window = run.context.contextWindow;
  }
  const tokens = latest?.context?.contextTokens ?? (latest !== undefined && latest.usage === null && window !== null ? 0 : null);
  const percent = tokens === null || window === null ? null : Math.min(100, Math.max(0, Math.round(tokens / window * 100)));
  return { supported: true, model, tokens, window, percent };
};
