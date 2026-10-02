import { useEffect, useMemo, useRef, useState } from "react";
import {
  forkedFrom,
  gaugeOf,
  hear,
  liveRunIdOf,
  lockOf,
  nextQuietChange,
  runningCalls,
  type Clock,
  type ForkedEntry,
  type ForkedFrom,
  type Lock,
  type QuietCalls,
  type RunState,
  type Runtime,
  type SessionProjection,
  type SessionRunsView,
} from "@agent-harness/client-runtime";
import type { AdapterCapabilities, CommandsListEntry } from "@agent-harness/contracts";
import { markOf, planDelta, type PlanMark } from "../transcript/plan.js";

/**
 * The session on screen (docs/specs/tui.md, "The transcript" and "The
 * composer"): which one is open, its `projections.session` followed while it
 * is (following holds its subscription; letting go starts the runtime's five
 * minutes), its run state from `projections.runs`, and its queue and the
 * verbs of ADR 0022 from `projections.runs.session`, the composer's lock from
 * `capability`, its provider's descriptor and its `/` menu's listing (its
 * skills and the provider's own commands, `commands.list`, #503) from the
 * request cache, and how long each running call has been quiet. A fork's source is
 * followed too while the fork opens on its `forked` entry, for what an older row without copied history names (#390, #242). Which session is open is client-local presentation, held in
 * memory only.
 */

export interface Opened {
  readonly environmentId: string;
  readonly sessionId: string;
}

export interface OpenSession {
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  /** The session's run state; undefined with none open. */
  readonly runState: RunState | undefined;
  /** Its queue, its rewind and each verb of ADR 0022, present or absent with its reason (`projections.runs.session`); undefined with none open. */
  readonly runs: SessionRunsView | undefined;
  /** The run a send joins and Esc interrupts: the live run the projection or the run states name. */
  readonly liveRunId: string | undefined;
  readonly lock: Lock;
  /** The session's provider, when `providers.list` has answered. */
  readonly provider: AdapterCapabilities | undefined;
  /** The session's skills and its provider's own slash commands (`commands.list`), when its adapter lists them. */
  readonly listedCommands: readonly CommandsListEntry[];
  /** When each running call was last heard. */
  readonly quiet: QuietCalls;
  /** The plan windows a finished run moved, in words, for a run this terminal saw running. */
  planDeltas(runId: string): readonly string[];
  /** What the open fork's `forked` row names of its source (its title, else the list's, and the prompt it was taken at); undefined when it is no fork. */
  readonly forkedFrom: ForkedFrom | undefined;
  open(opened: Opened | null): void;
}

/** Follows `observable` while it is defined, drawing a frame on each change. */
export const useFollow = (observable: { subscribe(listener: () => void): () => void } | undefined, request: () => void): void => {
  useEffect(() => observable?.subscribe(request), [observable, request]);
};

export const useSession = (runtime: Runtime, clock: Clock, request: () => void): OpenSession => {
  const [opened, setOpened] = useState<Opened | null>(null);
  const environmentId = opened?.environmentId;
  const sessionId = opened?.sessionId;
  const view = useMemo(() => (environmentId !== undefined && sessionId !== undefined ? runtime.projections.session(environmentId, sessionId) : undefined), [runtime, environmentId, sessionId]);
  useFollow(view, request);
  useFollow(opened ? runtime.projections.runs : undefined, request);
  const sessionRuns = useMemo(
    () => (environmentId !== undefined && sessionId !== undefined ? runtime.projections.runs.session(environmentId, sessionId) : undefined),
    [runtime, environmentId, sessionId],
  );
  useFollow(sessionRuns, request);
  const providers = useMemo(() => (environmentId !== undefined ? runtime.requests.cached(environmentId, "providers.list", {}) : undefined), [runtime, environmentId]);
  useFollow(providers, request);

  const projection = view?.read();
  const summary = projection?.summary ?? null;
  // Older forks need their source for labels; a copied seed is independent of it (#242).
  const forked = projection?.items.find((item): item is ForkedEntry => item.kind === "forked");
  const sourceId = forked?.history === undefined ? forked?.fromSessionId : undefined;
  const source = useMemo(
    () => (environmentId !== undefined && sourceId !== undefined ? runtime.projections.session(environmentId, sourceId) : undefined),
    [runtime, environmentId, sourceId],
  );
  useFollow(source, request);
  const from = forked === undefined ? undefined : forkedFrom(forked, source?.read());
  const listedTitle = (): string | null =>
    runtime.projections.sessionList.read().rows.find((row) => row.environmentId === environmentId && row.summary.id === sourceId?.toLowerCase())?.summary.title ?? null;
  const listed = providers?.read().result?.providers ?? [];
  // One adapter in phase A; with several, the session's account names its provider, once the accounts (followed while open) are known.
  const accounts = useMemo(() => (environmentId !== undefined ? runtime.projections.accounts(environmentId) : undefined), [runtime, environmentId]);
  useFollow(accounts, request);
  const accountProvider =
    summary?.accountId && accounts ? accounts.read().value?.find((a) => a.id === summary.accountId)?.provider : undefined;
  const provider = listed.find((p) => p.provider === accountProvider) ?? (listed.length === 1 ? listed[0] : undefined);

  // Keyed by the open session (#503): the environment lists it under that session's account, workspace and trust.
  const commands = useMemo(
    () => (environmentId !== undefined && sessionId !== undefined && provider?.commands === true ? runtime.requests.cached(environmentId, "commands.list", { sessionId }) : undefined),
    [runtime, environmentId, sessionId, provider?.commands],
  );
  useFollow(commands, request);

  // What each run cost the plan: its account's windows when it is first seen running, against a reading observed since.
  useFollow(opened ? runtime.projections.usage : undefined, request);
  const marks = useRef(new Map<string, PlanMark>());
  const moved = useRef(new Map<string, readonly string[]>());
  if (projection && environmentId !== undefined) {
    const gauges = runtime.projections.usage.read().gauges;
    for (const run of projection.runs) {
      const mark = markOf(gaugeOf(gauges, environmentId, run.accountId));
      const before = marks.current.get(run.runId);
      if (run.state === "running" && before === undefined && mark.size > 0) marks.current.set(run.runId, mark);
      if (run.state === "ended" && before !== undefined && !moved.current.has(run.runId)) {
        const words = planDelta(before, mark);
        if (words !== null) moved.current.set(run.runId, words);
      }
    }
  }

  const runs = opened ? runtime.projections.runs.read().sessions.get(opened.environmentId)?.get(opened.sessionId) : undefined;

  // The quiet calls: heard afresh on every render, with a frame asked for when one turns amber or its minute moves on.
  const heard = useRef<QuietCalls>(new Map());
  heard.current = hear(heard.current, projection ? runningCalls(projection) : [], clock.now().getTime());
  const next = nextQuietChange(heard.current, clock.now().getTime());
  useEffect(() => {
    if (next === undefined) return;
    const timer = clock.setTimeout(request, Math.max(0, next - clock.now().getTime()));
    return () => timer.cancel();
  }, [clock, next, request]);

  return {
    opened,
    projection,
    runState: runs?.state,
    runs: sessionRuns?.read(),
    liveRunId: liveRunIdOf(projection ?? { runs: [] }, runs),
    lock: opened ? lockOf(runtime.capability(opened.environmentId, "runs.send")) : { locked: false },
    provider,
    listedCommands: commands?.read().result?.entries ?? [],
    quiet: heard.current,
    planDeltas: (runId) => moved.current.get(runId) ?? [],
    forkedFrom: from === undefined ? undefined : { title: from.title ?? listedTitle(), anchor: from.anchor },
    open: setOpened,
  };
};
