import { useEffect, useMemo, useRef } from "react";
import type { Clock, ParkedAsk, RunsView, Runtime, SessionListView } from "@agent-harness/client-runtime";
import { askKey } from "../cards/asks.js";
import { useFollow, type Opened } from "../session/use-session.js";
import { lastReply } from "../transcript/rows.js";
import { AttentionTimer, titleFor, type TerminalChrome } from "./chrome.js";
import { AWAY_MS, awayRecap, noticeFor, titleStateOf, type RecapSubject, type RunEnded } from "./policy.js";

/**
 * Attention (docs/specs/tui.md, "Attention"; Artemis's chrome effects at
 * 443cf2e): the runtime's attention events drive Artemis's attention module.
 *
 * - **The title** says what every session of every enabled environment is
 *   doing (`projections.runs`), with the open session's name and workspace;
 *   written through the chrome whenever it changes, and handed back when the
 *   terminal UI goes.
 * - **The bell** for a prompt: a `prompt-parked` event makes its prompt news;
 *   while one such prompt is still parked (in `projections.runs`' parked
 *   asks) the six-second bell is armed, and it names the session and what
 *   waits; once none is, it is disarmed. A prompt parked before this
 *   terminal started is not news and rings nothing.
 * - **The bell** for a finished turn: a `run-ended` event for the open
 *   session arms the sixty-second bell; a run starting on the open session
 *   disarms it. It names the session whose run ended and the first line of
 *   that session's last reply, read when it rings (the runtime still holds a
 *   session it has let go for five minutes), whichever session is open by
 *   then.
 * - **A key** (`touch`) pushes both back; the key that ends three minutes of
 *   stillness is answered with the away summary: the sessions whose prompt
 *   parked or whose run ended meanwhile, in the rail's order.
 * - **What needs you** (`needing`, for `Ctrl+]`): the sessions parked on a
 *   prompt, oldest first, then those whose run ended since they were last on
 *   screen.
 */

export interface AttentionOptions {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly chrome: TerminalChrome;
  /** Draws a frame. */
  readonly request: () => void;
  readonly opened: Opened | null;
  /** The open session's title, when it has one. */
  readonly title: string | undefined;
  /** The workspace the title names: the open session's, else the header's. */
  readonly folder: string;
  /** Whether a run is live on the open session. */
  readonly live: boolean;
}

export interface AttentionState {
  /** A key was pressed: both bells wait again from now; the away summary when the press ends three minutes of stillness. */
  touch(): string | undefined;
  /** The sessions with a claim on this person, in the order `Ctrl+]` visits them. */
  needing(): readonly Opened[];
}

const sessionKey = (environmentId: string, sessionId: string): string => `${environmentId} ${sessionId.toLowerCase()}`;

/** What this terminal heard, on its own clock: which prompts parked as news, when each session last parked or ended, when each was last on screen. */
interface Heard {
  /** A prompt heard parking, and whether it has been seen among the parked asks since. */
  readonly news: Map<string, boolean>;
  readonly askedAt: Map<string, number>;
  readonly ends: Map<string, { readonly opened: Opened; readonly end: RunEnded }>;
  readonly shown: Map<string, number>;
}

/** Every session's activity, as the title reduces it. */
const activities = (runs: RunsView) =>
  [...runs.sessions.values()].flatMap((sessions) => [...sessions.values()].map((run) => ({ status: run.state, pendingPrompts: run.state === "parked" ? 1 : 0 })));

/** The sessions in the rail's order: its shelves, top to bottom. */
const inRailOrder = (list: SessionListView) => [...list.pinned, ...list.active, ...list.snoozed, ...list.settled, ...list.archived];

export const useAttention = (options: AttentionOptions): AttentionState => {
  const { runtime, clock, chrome, request, opened } = options;
  const timer = useMemo(() => new AttentionTimer(clock), [clock]);
  useEffect(() => () => timer.disarmAll(), [timer]);
  useFollow(runtime.projections.runs, request);
  const runs = runtime.projections.runs.read();
  const heard = useRef<Heard>({ news: new Map(), askedAt: new Map(), ends: new Map(), shown: new Map() });
  // What the callbacks read when they fire, which may be a minute after they were armed.
  const latest = useRef({ options, runs });
  latest.current = { options, runs };

  // The title: every session in one word, the open one named.
  const state = titleStateOf(activities(runs));
  const title = titleFor({ ...state, title: options.title, folder: options.folder });
  const written = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (written.current === title) return;
    written.current = title;
    chrome.setTitle(title);
  });
  useEffect(() => () => chrome.clearTitle(), [chrome]);

  // The events: a prompt parked is news; a run ended is remembered for the away summary, and on the open session arms the bell.
  useEffect(
    () =>
      runtime.attention.subscribe((event) => {
        const now = clock.now().getTime();
        if (event.kind === "prompt-parked") {
          heard.current.news.set(askKey(event), false);
          heard.current.askedAt.set(sessionKey(event.environmentId, event.sessionId), now);
          request();
          return;
        }
        if (event.kind !== "run-ended") return;
        const key = sessionKey(event.environmentId, event.sessionId);
        heard.current.ends.set(key, { opened: { environmentId: event.environmentId, sessionId: event.sessionId }, end: { at: now, failed: event.reason === "error" } });
        const open = latest.current.options.opened;
        if (open === null || sessionKey(open.environmentId, open.sessionId) !== key) return;
        const { environmentId, sessionId } = event;
        timer.arm("finished", () => {
          const listed = runtime.projections.sessionList.read().rows.find((row) => row.environmentId === environmentId && row.summary.id === sessionId.toLowerCase());
          const reply = lastReply(runtime.projections.session(environmentId, sessionId).read())?.text;
          const session = listed?.summary.title;
          latest.current.options.chrome.notify(noticeFor("finished", { ...(session !== undefined && { session }), ...(reply !== undefined && { reply }) }));
        });
      }),
    [runtime, clock, timer, request],
  );

  // The prompt bell: armed while a prompt heard parking is still parked, disarmed once none is.
  const parkedNews = (asks: readonly ParkedAsk[]) => asks.find((ask) => heard.current.news.has(askKey(ask)));
  const waiting = parkedNews(runs.parkedAsks) !== undefined;
  useEffect(() => {
    const { news } = heard.current;
    const parked = new Set(runs.parkedAsks.map(askKey));
    // A prompt seen parked and now gone was answered: never parked again, so it is forgotten.
    for (const [key, seen] of news) {
      if (parked.has(key)) news.set(key, true);
      else if (seen) news.delete(key);
    }
  });
  useEffect(() => {
    if (!waiting) return timer.disarm("needs-you");
    timer.arm("needs-you", () => {
      const ask = parkedNews(latest.current.runs.parkedAsks);
      if (!ask) return;
      latest.current.options.chrome.notify(
        noticeFor("needs-you", { ...(ask.title !== null && { session: ask.title }), prompt: ask.kind, ...(ask.prompt.toolName !== null && { tool: ask.prompt.toolName }) }),
      );
    });
  }, [waiting, timer]);

  // A turn going on the open session is the answer to the last one: nothing is owed about it.
  useEffect(() => {
    if (options.live) timer.disarm("finished");
  }, [options.live, timer]);

  // The session on screen is being looked at; the one it replaces was looked at until now.
  const openKey = opened ? sessionKey(opened.environmentId, opened.sessionId) : undefined;
  useEffect(() => {
    if (openKey === undefined) return;
    const { shown } = heard.current;
    shown.set(openKey, clock.now().getTime());
    return () => void shown.set(openKey, clock.now().getTime());
  }, [openKey, clock]);

  return {
    touch() {
      const away = timer.idleMs();
      timer.touch();
      if (away < AWAY_MS) return undefined;
      const now = clock.now().getTime();
      const { runs: current } = latest.current;
      const subjects = inRailOrder(runtime.projections.sessionList.read()).map((row): RecapSubject => {
        const key = sessionKey(row.environmentId, row.summary.id);
        const status = current.sessions.get(row.environmentId)?.get(row.summary.id.toLowerCase())?.state ?? "idle";
        return {
          title: row.summary.title,
          status,
          pendingPrompts: status === "parked" ? 1 : 0,
          lastRun: heard.current.ends.get(key)?.end,
          askedAt: heard.current.askedAt.get(key),
        };
      });
      return awayRecap(subjects, now - away);
    },
    needing() {
      const { runs: current, options: now } = latest.current;
      const parked = new Map<string, Opened>();
      for (const ask of current.parkedAsks) parked.set(sessionKey(ask.environmentId, ask.sessionId), { environmentId: ask.environmentId, sessionId: ask.sessionId });
      const here = now.opened ? sessionKey(now.opened.environmentId, now.opened.sessionId) : undefined;
      const finished = [...heard.current.ends]
        .filter(([key, { end }]) => !parked.has(key) && key !== here && end.at > (heard.current.shown.get(key) ?? 0))
        .sort(([, a], [, b]) => a.end.at - b.end.at)
        .map(([, { opened: session }]) => session);
      return [...parked.values(), ...finished];
    },
  };
};
