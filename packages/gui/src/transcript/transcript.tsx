import {
  hear,
  liveRun,
  liveTasks,
  nextQuietChange,
  oneLine,
  quietFor,
  runningCalls,
  transcriptRows,
  type QuietCalls,
  type SessionProjection,
} from "@agent-harness/client-runtime";
import type { DelegatedWorkRow } from "@agent-harness/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import type { ReadingWidth } from "../presentation.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";
import { TranscriptRowView, type RowFacts } from "./rows.js";

export interface TranscriptProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/** How wide the column of rows may grow, by the reading-width preference. */
const COLUMN_WIDTHS: Readonly<Record<ReadingWidth, string>> = { comfortable: "920px", wide: "1280px", full: "none" };

/** How near the end, in pixels, still counts as at the end: a scroll that lands this close follows the end again. */
const AT_END_PX = 48;

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
 * Following the end: the scroll box kept at its end as what it holds grows,
 * until David scrolls up (a scroll that moved up, not merely one short of
 * the end, since the box growing moves nothing), and again once he scrolls
 * back to the end or jumps there.
 */
const useFollow = () => {
  const box = useRef<HTMLElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  /** Where the box was last scrolled to, the follower's own moves included: how a scroll up is told from the box growing. */
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);

  const toEnd = useCallback(() => {
    const element = box.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  }, []);

  // After every render: what was drawn may have grown the box.
  useLayoutEffect(() => {
    if (following.current) toEnd();
  });
  // And whatever grows it without a render of the transcript: a fold opened, an image loaded.
  useEffect(() => {
    const content = column.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) toEnd();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [toEnd]);

  const onScroll = useCallback(() => {
    const element = box.current;
    if (element === null) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END_PX;
    const movedUp = element.scrollTop < lastTop.current;
    lastTop.current = element.scrollTop;
    if (atEnd) following.current = true;
    else if (movedUp) following.current = false;
    setAway(!following.current);
  }, []);

  const jump = useCallback(() => {
    following.current = true;
    setAway(false);
    toEnd();
  }, [toEnd]);

  return { box, column, away, onScroll, jump };
};

/**
 * A session's conversation (docs/specs/gui.md, "A session pane"; #399):
 * `projections.session` drawn as the runtime's transcript rows, which the
 * terminal UI draws too, so the two fold a session alike (ADR 0004).
 * Following the projection holds the session's subscription while the
 * transcript is on screen. It is bottom-anchored and follows new output
 * until David scrolls up, offering a way back to the end. Until its stream
 * is live a marker heads it: the catch-up under way, or what this window
 * last saw of it while its environment is not answering. Under it, the live
 * run's delegated work still going. Its text size and reading width are
 * presentation, read on each render.
 */
export const Transcript = ({ environmentId, sessionId }: TranscriptProps) => {
  const runtime = useRuntime();
  const session = useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]);
  const projection = useObservable(session);
  const environments = useObservable(runtime.projections.environments);
  const [textSize] = usePresentation("textSize");
  const [readingWidth] = usePresentation("readingWidth");
  const rows = useMemo(() => transcriptRows(projection), [projection]);
  const tasks = useMemo(() => liveTasks(projection, liveRun(projection)?.runId), [projection]);
  // What the stream held when it first went live was written before this transcript was watching: only what comes after arrives.
  const [liveFrom, setLiveFrom] = useState<number | null>(null);
  if (liveFrom === null && projection.freshness === "live") setLiveFrom(headOf(projection));
  const quietMs = useQuietCalls(projection);
  const facts: RowFacts = { arrived: (sequence) => liveFrom !== null && sequence > liveFrom, quietMs };
  const follow = useFollow();
  const name = environments.find((environment) => environment.environmentId === environmentId)?.name ?? THIS_MACHINE;
  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <section
          aria-label="Transcript"
          ref={follow.box}
          onScroll={follow.onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain text-ink"
          style={{ fontSize: `${textSize}px` }}
        >
          <div ref={follow.column} className="mx-auto flex min-h-full w-full flex-col justify-end gap-3 px-4 py-3.5" style={{ maxWidth: COLUMN_WIDTHS[readingWidth] }}>
            {projection.freshness !== "live" && (
              <p role="status" className="text-[0.85em] text-ink-muted">
                {projection.freshness === "cached" ? `Cached: what this window last saw of it; ${name} is not answering` : "Catching up…"}
              </p>
            )}
            {rows.length === 0 && (projection.deleted || projection.freshness === "live") && (
              <p className="text-ink-faint">{projection.deleted ? "This session was deleted." : "Nothing said yet."}</p>
            )}
            {rows.map((row) => (
              <TranscriptRowView key={row.id} row={row} facts={facts} />
            ))}
          </div>
        </section>
        {follow.away && (
          <Button onClick={follow.jump} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-float">
            Jump to the latest
          </Button>
        )}
      </div>
      <DelegatedStrip tasks={tasks} />
    </>
  );
};

/** The live run's delegated work still going, each with its agent: the strip under the transcript. */
const DelegatedStrip = ({ tasks }: { readonly tasks: readonly DelegatedWorkRow[] }) =>
  tasks.length === 0 ? null : (
    <ul aria-label="Delegated work" className="flex shrink-0 flex-col gap-0.5 border-t border-hairline px-4 py-1.5 text-xs text-ink-muted">
      {tasks.map((task) => (
        <li key={task.taskId}>
          <span className="text-cyan">{task.subagentType ?? task.kind}</span>: {oneLine(task.description, 120)} · {task.status}
        </li>
      ))}
    </ul>
  );
