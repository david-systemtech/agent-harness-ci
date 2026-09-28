import { hear, liveRun, liveTasks, nextQuietChange, oneLine, quietFor, runningCalls, transcriptRows, type QuietCalls, type SessionProjection } from "@agent-harness/client-runtime";
import { useEffect, useMemo, useReducer, useState } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { TranscriptRowView, type RowFacts } from "./rows.js";

export interface TranscriptProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/** The latest sequence the transcript holds: where what arrives after it begins. */
const headOf = (projection: SessionProjection): number => projection.items.reduce((head, entry) => Math.max(head, entry.sequence), 0);

/**
 * How long each running call has said nothing, on the window's clock: heard
 * afresh on every render, and drawn again when one turns amber or its
 * minutes move on.
 */
const useQuietCalls = (projection: SessionProjection): ((toolCallId: string) => number) => {
  const clock = useClock();
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [heard, setHeard] = useState<QuietCalls>(new Map());
  const now = clock.now().getTime();
  const current = hear(heard, runningCalls(projection), now);
  if (current !== heard) setHeard(current);
  const due = nextQuietChange(current, now);
  useEffect(() => {
    if (due === undefined) return;
    const timer = clock.setTimeout(redraw, Math.max(0, due - clock.now().getTime()));
    return () => timer.cancel();
  }, [clock, due]);
  return (toolCallId) => quietFor(current, toolCallId, now);
};

/**
 * A session's conversation (docs/specs/gui.md, "A session pane"; #399):
 * `projections.session` drawn as the runtime's transcript rows, which the
 * terminal UI draws too, so the two fold a session alike (ADR 0004).
 * Following the projection holds the session's subscription while the
 * transcript is on screen. Until its stream is live, a marker heads it: the
 * catch-up under way, or what this window last saw of it while its
 * environment is not answering.
 */
export const Transcript = ({ environmentId, sessionId }: TranscriptProps) => {
  const runtime = useRuntime();
  const session = useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]);
  const projection = useObservable(session);
  const environments = useObservable(runtime.projections.environments);
  const rows = useMemo(() => transcriptRows(projection), [projection]);
  // What the stream held when it first went live was written before this transcript was watching: only what comes after arrives.
  const [liveFrom, setLiveFrom] = useState<number | null>(null);
  if (liveFrom === null && projection.freshness === "live") setLiveFrom(headOf(projection));
  const quietMs = useQuietCalls(projection);
  const facts: RowFacts = { arrived: (sequence) => liveFrom !== null && sequence > liveFrom, quietMs };
  const name = environments.find((environment) => environment.environmentId === environmentId)?.name ?? THIS_MACHINE;
  const tasks = useMemo(() => liveTasks(projection, liveRun(projection)?.runId), [projection]);
  return (
    <>
    <section aria-label="Transcript" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full flex-col gap-3 px-4 py-3.5">
        {projection.freshness !== "live" && (
          <p role="status" className="text-xs text-ink-muted">
            {projection.freshness === "cached" ? `Cached: what this window last saw of it; ${name} is not answering` : "Catching up…"}
          </p>
        )}
        {rows.length === 0 && (projection.deleted || projection.freshness === "live") && (
          <p className="text-sm text-ink-faint">{projection.deleted ? "This session was deleted." : "Nothing said yet."}</p>
        )}
        {rows.map((row) => (
          <TranscriptRowView key={row.id} row={row} facts={facts} />
        ))}
      </div>
    </section>
    {tasks.length > 0 && (
      <ul aria-label="Delegated work" className="flex shrink-0 flex-col gap-0.5 border-t border-hairline px-4 py-1.5 text-xs text-ink-muted">
        {tasks.map((task) => (
          <li key={task.taskId}>
            <span className="text-cyan">{task.subagentType ?? task.kind}</span>: {oneLine(task.description, 120)} · {task.status}
          </li>
        ))}
      </ul>
    )}
    </>
  );
};
