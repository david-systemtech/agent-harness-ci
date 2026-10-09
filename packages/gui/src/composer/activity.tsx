import { elapsedClock, liveRun, liveRunIdOf, liveTasks, oneLine, statusOf } from "@agent-harness/client-runtime";
import { useEffect, useMemo, useReducer } from "react";
import { ListTodo } from "lucide-react";
import { showPane, useSideColumn } from "../side-column/column.js";
import { Button, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** The run's seam and labelled tail, in environment time; settled has only its hairline. */
export const Activity = ({ environmentId, sessionId, stopping }: { readonly environmentId: string; readonly sessionId: string; readonly stopping: boolean }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const facts = statusOf({ projection, runState: runs.state, liveRunId: liveRunIdOf(projection, runs), ceiling: null, forkedOnto: undefined, containmentDefault: undefined, recommendation: undefined, now: () => runtime.environmentNow(environmentId).getTime() });
  const latest = projection.runs.at(-1);
  const state = stopping && facts.live ? "stopping" : facts.activity.kind !== "idle" ? facts.activity.kind : latest?.reason === "error" ? "failed" : "settled";
  const active = state === "stopping" || state === "waiting" || state === "starting" || state === "working";
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const second = Math.floor(runtime.environmentNow(environmentId).getTime() / 1000);
  useEffect(() => {
    if (!active) return;
    const timer = clock.setTimeout(tick, 1000);
    return () => timer.cancel();
  }, [clock, active, second]);
  const words = state === "stopping" ? "Stopping…" : state === "failed" ? `Run failed${latest?.error === null || latest?.error === undefined ? "" : `: ${latest.error.message}`}` : facts.activity.words;
  const elapsed = facts.elapsedMs ?? (state === "failed" ? latest?.durationMs : undefined);
  return <>
    <div data-activity-seam data-activity={state} aria-hidden="true" className={classes("shrink-0 transition-[height] duration-200 motion-reduce:transition-none", state === "settled" ? "h-px bg-hairline" : "h-[3px]", state === "waiting" && "bg-amber", state === "failed" && "bg-signal", (state === "stopping" || state === "starting" || state === "working") && "shuttle bg-wash")} />
    {state !== "settled" && <p className={classes("flex shrink-0 items-baseline gap-2 px-3 py-1 text-xs", state === "waiting" ? "text-amber" : state === "failed" || state === "stopping" ? "text-signal" : "text-cyan")}>
      <span role="status" aria-label="Run activity" className="min-w-0 truncate" title={words}>{words}</span>
      {active || elapsed != null ? <span className="ml-auto shrink-0 font-mono text-2xs text-ink-muted">{elapsedClock(Math.max(1000, elapsed ?? 1000))}</span> : null}
    </p>}
  </>;
};


/** Live delegated work stays a projection of the ledger; the strip opens the pane that owns its controls. */
export const BackgroundWork = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const tasks = useMemo(() => liveTasks(projection, liveRun(projection)?.runId), [projection]);
  const [, changeColumn] = useSideColumn({ environmentId, sessionId });
  if (tasks.length === 0) return null;
  return <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1 text-xs text-ink-muted">
    <ul aria-label="Delegated work" className="min-w-0 flex-1">
      {tasks.map((task) => <li key={task.taskId} className="truncate" title={task.description}><span className="text-cyan">{task.subagentType ?? task.kind}</span>: {oneLine(task.description, 120)} · {task.status}</li>)}
    </ul>
    <Tooltip content="Open background work in Tasks · /tasks"><Button aria-label="Open background work in Tasks" size="xs" onClick={() => changeColumn((column) => showPane(column, "tasks"))}><ListTodo aria-hidden="true" />Tasks</Button></Tooltip>
  </div>;
};
