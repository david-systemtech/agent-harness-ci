import { LOCAL_PLACEHOLDER_ID, harnessActivity, lastReply, notificationFor, type AttentionEvent, type HarnessActivity, type Runtime, type ShellNotification } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { useEffect, useRef } from "react";
import { paneShowing } from "../grid/layout.js";
import { useOpenInFocusedPane } from "../grid/open-session.js";
import type { PaneLayout, PaneSession } from "../presentation.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

/**
 * Attention (docs/specs/gui.md, "Parked asks, attention and notices"; story
 * 11; #149's attention is the reference): what the window says through the
 * desktop's shell while nobody looks at it.
 *
 * - **The title** says what every session of every enabled environment is
 *   doing, in one word (`harnessActivity`): "needs you" while one waits on a
 *   prompt, else "working" while a run is in flight, else "ready".
 * - **The badge** counts the sessions with a parked prompt, cleared at none.
 * - **A notification**, while the window is unfocused and never while it is
 *   focused, for each of the runtime's attention events that asks for one: a
 *   prompt parked (`prompt-parked`), a run ended in a session the grid shows
 *   (`run-ended`), and a routine's delivered result (a `routine` notice), in
 *   the words the terminal UI rings with (`notificationFor`), a routine's
 *   being its notice's line. Its tag is the session's link, which a click
 *   hands back (`notifications.onActivate`): the window is focused and the
 *   session opens in the focused pane. A routine's skip names no session, so
 *   its notification carries no tag.
 *
 * Each member is used only while the shell has it (`capability`); in a
 * browser tab there is none. Whether the window is focused is the page's own
 * `focus` and `blur`, starting from `document.hasFocus()`.
 */

/** The title's word for what the harness is doing. */
const TITLE_WORDS: Readonly<Record<HarnessActivity, string>> = { "needs-you": "needs you", working: "working", ready: "ready" };

/** A session as a notification's tag: a link of the app's own (a chosen default), handed back when the notification is clicked. */
const sessionTag = ({ environmentId, sessionId }: PaneSession): string => `${PRODUCT_NAME}://session/${encodeURIComponent(environmentId)}/${encodeURIComponent(sessionId)}`;

const SESSION_TAG = new RegExp(`^${PRODUCT_NAME}://session/([^/?#\\s]+)/([^/?#\\s]+)$`);

/** The session a tag names; undefined for any other string. */
const sessionOfTag = (tag: string): PaneSession | undefined => {
  const match = SESSION_TAG.exec(tag);
  if (!match) return undefined;
  try {
    return { environmentId: decodeURIComponent(match[1] as string), sessionId: decodeURIComponent(match[2] as string) };
  } catch {
    return undefined;
  }
};

/** Whether the window is focused now, as its page last heard: a ref, read when an event comes. */
const useWindowFocused = (): { readonly current: boolean } => {
  const focused = useRef(document.hasFocus());
  useEffect(() => {
    const focus = () => void (focused.current = true);
    const blur = () => void (focused.current = false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return focused;
};

/** The session's title as the window's list holds it; undefined for one it does not. */
const titleOf = (runtime: Runtime, { environmentId, sessionId }: PaneSession): string | undefined =>
  runtime.projections.sessionList.read().rows.find((row) => row.environmentId === environmentId && row.summary.id === sessionId.toLowerCase())?.summary.title;

/** The notification an attention event raises, with the grid as it is; none for an event that raises none. */
const notificationOf = (runtime: Runtime, layout: PaneLayout, event: AttentionEvent): ShellNotification | undefined => {
  switch (event.kind) {
    case "prompt-parked": {
      const { environmentId, sessionId, promptId } = event;
      const tool = runtime.projections.runs.read().parkedAsks.find((ask) => ask.environmentId === environmentId && ask.promptId === promptId)?.prompt.toolName ?? undefined;
      const { title, body } = notificationFor("needs-you", { session: event.title, prompt: event.promptKind, ...(tool !== undefined && { tool }) });
      return { title, body, tag: sessionTag({ environmentId, sessionId }) };
    }
    case "run-ended": {
      const session = { environmentId: event.environmentId, sessionId: event.sessionId };
      if (paneShowing(layout, session) === undefined) return undefined;
      const title = titleOf(runtime, session);
      const reply = lastReply(runtime.projections.session(session.environmentId, session.sessionId).read())?.text;
      const words = notificationFor("finished", { ...(title !== undefined && { session: title }), ...(reply !== undefined && { reply }) });
      return { title: words.title, body: words.body, tag: sessionTag(session) };
    }
    case "notice-arrived": {
      const { notice } = event;
      if (notice.kind !== "routine") return undefined;
      const session = notice.about === null ? undefined : { environmentId: notice.environmentId, sessionId: notice.about.sessionId };
      const title = session === undefined ? undefined : titleOf(runtime, session);
      return { title: title ?? PRODUCT_NAME, body: notice.message, ...(session !== undefined && { tag: sessionTag(session) }) };
    }
  }
};

/** The window's title, badge and notifications, from the runtime's projections and attention events; draws nothing. */
export const WindowAttention = () => {
  const runtime = useRuntime();
  const shell = useShell();
  const openInPane = useOpenInFocusedPane();
  const focused = useWindowFocused();
  const [layout] = usePresentation("paneLayout");
  // What an event reads when it comes: the grid as it is then.
  const grid = useRef(layout);
  grid.current = layout;

  const { state, needing } = harnessActivity(useObservable(runtime.projections.runs));
  const windowMember = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.window").status === "present" ? shell?.window : undefined;
  const title = `${TITLE_WORDS[state]} · ${PRODUCT_NAME}`;
  useEffect(() => windowMember?.setTitle(title), [windowMember, title]);
  useEffect(() => windowMember?.setBadge(needing > 0 ? needing : undefined), [windowMember, needing]);

  const show = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.notifications.show").status === "present" ? shell?.notifications?.show : undefined;
  useEffect(() => {
    if (show === undefined) return undefined;
    return runtime.attention.subscribe((event) => {
      if (focused.current) return;
      const notification = notificationOf(runtime, grid.current, event);
      // One the OS could not show is let go: the window says the same itself (the Parked asks, the toasts, the session).
      if (notification !== undefined) void show(notification).catch(() => undefined);
    });
  }, [runtime, show, focused]);

  const onActivate = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.notifications.onActivate").status === "present" ? shell?.notifications?.onActivate : undefined;
  useEffect(
    () =>
      onActivate?.((tag) => {
        const session = sessionOfTag(tag);
        if (session === undefined) return;
        windowMember?.focus();
        openInPane(session);
      }),
    [onActivate, windowMember, openInPane],
  );
  return null;
};
