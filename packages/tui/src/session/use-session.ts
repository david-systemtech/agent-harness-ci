import { useEffect, useMemo, useRef, useState } from "react";
import type { Clock, RunState, Runtime, SessionProjection, SessionRunsView } from "@agent-harness/client-runtime";
import type { AdapterCapabilities, CommandEntry } from "@agent-harness/contracts";
import { gaugeOf, markOf, planDelta, type PlanMark } from "../transcript/plan.js";
import { hear, nextQuietChange, runningCalls, type QuietCalls } from "../transcript/quiet.js";
import { lockOf, type Lock } from "./send.js";

/**
 * The session on screen (docs/specs/tui.md, "The transcript" and "The
 * composer"): which one is open, its `projections.session` followed while it
 * is (following holds its subscription; letting go starts the runtime's five
 * minutes), its run state from `projections.runs`, and its queue and the
 * verbs of ADR 0022 from `projections.runs.session`, the composer's lock from
 * `capability`, its provider's descriptor and slash commands from the request
 * cache, and how long each running call has been quiet. Which session is open
 * is client-local presentation, held in memory only.
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
  /** The provider's own slash commands, when its adapter lists them. */
  readonly providerCommands: readonly CommandEntry[];
  /** When each running call was last heard. */
  readonly quiet: QuietCalls;
  /** The plan windows a finished run moved, in words, for a run this terminal saw running. */
  planDeltas(runId: string): readonly string[];
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
  const listed = providers?.read().result?.providers ?? [];
  // One adapter in phase A; with several, the session's account names its provider, once the accounts (followed while open) are known.
  const accounts = useMemo(() => (environmentId !== undefined ? runtime.projections.accounts(environmentId) : undefined), [runtime, environmentId]);
  useFollow(accounts, request);
  const accountProvider =
    summary?.accountId && accounts ? accounts.read().value?.find((a) => a.id === summary.accountId)?.provider : undefined;
  const provider = listed.find((p) => p.provider === accountProvider) ?? (listed.length === 1 ? listed[0] : undefined);

  const workspace = summary?.workspace;
  const accountId = summary?.accountId ?? undefined;
  const commandsKey = workspace ? JSON.stringify([workspace, accountId ?? null]) : undefined;
  const commands = useMemo(
    () =>
      environmentId !== undefined && workspace !== undefined && commandsKey !== undefined && provider?.commands === true
        ? runtime.requests.cached(environmentId, "commands.list", { workspace, ...(accountId !== undefined && { accountId }) })
        : undefined,
    // The workspace and account are read through their key, so an equal summary does not make a new query.
    [runtime, environmentId, commandsKey, provider?.commands],
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
  const liveRun = projection?.runs.findLast((run) => run.state === "running")?.runId;

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
    liveRunId: liveRun ?? (runs?.state === "running" || runs?.state === "parked" ? (runs.runId ?? undefined) : undefined),
    lock: opened ? lockOf(runtime.capability(opened.environmentId, "runs.send")) : { locked: false },
    provider,
    providerCommands: commands?.read().result?.commands ?? [],
    quiet: heard.current,
    planDeltas: (runId) => moved.current.get(runId) ?? [],
    open: setOpened,
  };
};
