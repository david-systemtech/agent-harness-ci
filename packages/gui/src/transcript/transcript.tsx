import {
  hear,
  nextQuietChange,
  quietFor,
  runningCalls,
  transcriptRows,
  type QuietCalls,
  type SessionProjection,
} from "@agent-harness/client-runtime";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import type { ReadingWidth } from "../presentation.js";
import { KeyContext } from "../keys/key-dispatch.js";
import { withQueued } from "../queue/placement.js";
import { QueuedRow } from "../queue/queued.js";
import { useSessionQueue } from "../queue/session-queue.js";
import { usePaneDocuments, type Revealed } from "../session/pane-documents.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";
import { FindBar, FindKeys, FindQuery, useFindBar } from "./find.js";
import { TranscriptRowView, type RowFacts } from "./rows.js";

export interface TranscriptProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/** How wide the column of rows may grow, by the reading-width preference. */
export const COLUMN_WIDTHS: Readonly<Record<ReadingWidth, string>> = { comfortable: "920px", wide: "80rem", full: "none" };

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
 * until the reader scrolls up (a scroll that moved up, not merely one short of
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
    if (box.current) observer.observe(box.current);
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

  useEffect(() => {
    const pane = box.current?.closest("[data-dock-owner]");
    if (!pane) return;
    pane.addEventListener("phone-composer-fit", jump);
    return () => pane.removeEventListener("phone-composer-fit", jump);
  }, [jump]);

  /** Stops following the end, as a scroll up does: David was taken somewhere to read. */
  const stop = useCallback(() => {
    following.current = false;
    setAway(true);
  }, []);

  return { box, column, away, onScroll, jump, stop };
};

/**
 * Showing a call the transcript was asked to show (the Documents pane's "the transcript at the call that made it", #410):
 * its row's fold opens for it as it draws (`useOpenedFor`), then the transcript stops following the end, scrolls to the
 * call and focuses it. Run after the follower's own scroll to the end, which the same render may have asked for.
 */
const useReveal = (follow: { readonly column: RefObject<HTMLDivElement | null>; readonly stop: () => void }, revealed: Revealed | null) => {
  const { column, stop } = follow;
  useLayoutEffect(() => {
    if (revealed === null) return;
    const call = [...(column.current?.querySelectorAll<HTMLElement>("[data-tool-call]") ?? [])].find((element) => element.dataset["toolCall"] === revealed.toolCallId);
    if (call === undefined) return;
    stop();
    // Reveal only within the transcript; ancestor scrolling can pan the phone shell.
    const scroller = column.current?.parentElement;
    if (scroller) scroller.scrollTop += call.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (scroller.clientHeight - call.clientHeight) / 2;
    call.focus({ preventScroll: true });
  }, [column, stop, revealed]);
};

/**
 * A session's conversation (docs/specs/gui.md, "A session pane"; #399):
 * `projections.session` drawn as the runtime's transcript rows, which the
 * terminal UI draws too, so the two fold a session alike (ADR 0004), with
 * each message of the session's queue drawn after its turn (#401).
 * Following the projection holds the session's subscription while the
 * transcript is on screen. It is bottom-anchored and follows new output
 * until the reader scrolls up, offering a way back to the end. Until its stream
 * is live a marker heads it: the catch-up under way, or what this window
 * last saw of it while its environment is not answering. The composer owns
 * the live delegated-work strip below it. Its reading width is
 * presentation; text scales with the window root. Mod+F opens its find bar.
 */
export const Transcript = ({ environmentId, sessionId }: TranscriptProps) => {
  const runtime = useRuntime();
  const session = useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]);
  const projection = useObservable(session);
  const checks = useObservable(useMemo(() => runtime.projections.checks(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const environments = useObservable(runtime.projections.environments);
  const [readingWidth] = usePresentation("readingWidth");
  // A parked prompt waits on the card under the transcript, and is drawn here, where it was asked, once answered.
  const rows = useMemo(() => transcriptRows(projection).filter((row) => !(row.kind === "prompt" && row.entry.state === "parked")), [projection]);
  const { queue } = useSessionQueue().runs;
  const drawn = useMemo(() => withQueued(rows, queue), [rows, queue]);
  // What the stream held when it first went live was written before this transcript was watching: only what comes after arrives.
  const [liveFrom, setLiveFrom] = useState<number | null>(null);
  if (liveFrom === null && projection.freshness === "live") setLiveFrom(headOf(projection));
  const quietMs = useQuietCalls(projection);
  const { revealed } = usePaneDocuments();
  const facts: RowFacts = { arrived: (sequence) => liveFrom !== null && sequence > liveFrom, quietMs, workspace: projection.summary?.workspace.path ?? null, revealed, verbs: true, checkOutput: checks.runningOutput };
  const follow = useFollow();
  useReveal(follow, revealed);
  const find = useFindBar(follow.column, follow.stop);
  const name = environments.find((environment) => environment.environmentId === environmentId)?.name ?? THIS_MACHINE;
  return (
    <KeyContext context="transcript" conditions={find.conditions}>
      <FindKeys find={find} />
      <div data-transcript-region className="relative flex min-h-0 flex-1 flex-col">
        <section
          aria-label="Transcript"
          ref={follow.box}
          onScroll={follow.onScroll}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain text-sm text-ink outline-none"
        >
          <div ref={follow.column} className="mx-auto flex min-h-full w-full flex-col justify-end gap-3 px-4 py-3.5" style={{ maxWidth: COLUMN_WIDTHS[readingWidth] }}>
            {projection.freshness !== "live" && (
              <p role="status" className="text-[0.85em] text-ink-muted">
                {projection.freshness === "cached" ? `Cached: what this window last saw of it; ${name} is not answering` : "Catching up…"}
              </p>
            )}
            {drawn.length === 0 && (projection.deleted || projection.freshness === "live") && (
              <p className="text-ink-faint">{projection.deleted ? "This session was deleted." : "Nothing said yet."}</p>
            )}
            <FindQuery value={find.marked}>
              {drawn.map((item) =>
                item.kind === "row" ? (
                  <TranscriptRowView key={item.row.id} row={item.row} facts={facts} />
                ) : (
                  <QueuedRow key={`queued:${item.message.messageId}`} message={item.message} />
                ),
              )}
            </FindQuery>
          </div>
        </section>
        {follow.away && (
          <Button size="xs" variant="outline" title="Jump to the latest (Enter or Space)" onClick={follow.jump} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-float shadow-lg shadow-scrim/40">
            <ArrowDown aria-hidden="true" className="size-3" />Jump to the latest
          </Button>
        )}
        {find.open && <FindBar find={find} />}
      </div>
    </KeyContext>
  );
};
