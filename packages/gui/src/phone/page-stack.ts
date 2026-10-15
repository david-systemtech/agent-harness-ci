import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaneSession } from "../presentation.js";
import { sessionLink, sessionOfHash } from "../platform/browser-boot.js";

/** The phone's pages (audit §4.1): the sessions list is the root; everything else stacks on it. */
export type PhonePage =
  | { readonly kind: "sessions" }
  | { readonly kind: "session"; readonly session: PaneSession }
  | { readonly kind: "new-session" }
  | { readonly kind: "settings" };

export const SESSIONS_PAGE: PhonePage = { kind: "sessions" };
const STATE_KEY = "phonePages";

/** Each page is a history entry with its own address, so a link reopens the page. */
export const pageLink = (page: PhonePage): string => page.kind === "session" ? sessionLink(page.session)
  : page.kind === "new-session" ? "/#/new" : page.kind === "settings" ? "/#/settings" : "/";

/** The page an address names; an empty hash or `#/sessions` is the root. */
export const pageOfHash = (hash: string): PhonePage | undefined => {
  if (hash === "" || hash === "#" || hash === "#/" || hash === "#/sessions") return SESSIONS_PAGE;
  if (hash === "#/new") return { kind: "new-session" };
  if (hash === "#/settings") return { kind: "settings" };
  const session = sessionOfHash(hash);
  return session ? { kind: "session", session } : undefined;
};

export const samePage = (a: PhonePage, b: PhonePage): boolean => a.kind === b.kind && (a.kind !== "session" || b.kind !== "session"
  || (a.session.environmentId === b.session.environmentId && a.session.sessionId.toLowerCase() === b.session.sessionId.toLowerCase()));

const isPage = (value: unknown): value is PhonePage => {
  if (typeof value !== "object" || value === null) return false;
  const page = value as { kind?: unknown; session?: { environmentId?: unknown; sessionId?: unknown } };
  if (page.kind === "session") return typeof page.session?.environmentId === "string" && typeof page.session.sessionId === "string";
  return page.kind === "sessions" || page.kind === "new-session" || page.kind === "settings";
};

/** The stack a history entry holds, or the root plus the page its address names. */
export const stackOfEntry = (state: unknown, hash: string): readonly PhonePage[] => {
  const held = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[STATE_KEY] : undefined;
  const page = pageOfHash(hash) ?? SESSIONS_PAGE;
  // An entry's stack counts only while it still ends at the page its address names.
  if (Array.isArray(held) && held.length > 0 && held.every(isPage) && held[0]?.kind === "sessions" && samePage(held.at(-1) as PhonePage, page)) return held;
  return page.kind === "sessions" ? [SESSIONS_PAGE] : [SESSIONS_PAGE, page];
};

/** Switching between conversations replaces the top page; anything else deepens the stack. */
export const nextStack = (pages: readonly PhonePage[], page: PhonePage): { readonly pages: readonly PhonePage[]; readonly mode: "push" | "replace" } | undefined => {
  const top = pages.at(-1) ?? SESSIONS_PAGE;
  if (samePage(top, page)) return undefined;
  if (page.kind === "sessions") return { pages: [SESSIONS_PAGE], mode: "push" };
  const conversation = (p: PhonePage) => p.kind === "session" || p.kind === "new-session";
  if (conversation(top) && conversation(page)) return { pages: [...pages.slice(0, -1), page], mode: "replace" };
  return { pages: [...pages, page], mode: "push" };
};

export interface PhonePageStack {
  readonly pages: readonly PhonePage[];
  readonly top: PhonePage;
  /** Opens a page by `nextStack`'s rule; the same page again does nothing. */
  open(page: PhonePage): void;
  /** Leaves the top page through history, so the browser's own back does the same thing. */
  back(): void;
}

export type StackHistory = Pick<Window, "history" | "location" | "addEventListener" | "removeEventListener">;

/**
 * The page stack, held in history entries. Each entry carries the whole stack, so
 * browser back/forward, Android back and the header's chevron restore exactly
 * that stack. `interceptBack` lets an open sheet (the sessions drawer) take a back
 * first: the entry just left is put back and the stack stays where it was.
 */
export const usePhonePageStack = (enabled: boolean, options: { readonly interceptBack?: () => boolean; readonly view?: StackHistory; readonly initial?: PhonePage | undefined } = {}): PhonePageStack => {
  const view = options.view ?? window;
  const initialPage = useRef(options.initial);
  const [pages, setPages] = useState<readonly PhonePage[]>(() => enabled ? stackOfEntry(view.history.state, view.location.hash) : [SESSIONS_PAGE]);
  const held = useRef(pages);
  const intercept = useRef(options.interceptBack);
  intercept.current = options.interceptBack;
  const write = useCallback((next: readonly PhonePage[], mode: "push" | "replace") => {
    const state = { ...(typeof view.history.state === "object" && view.history.state !== null ? view.history.state as object : {}), [STATE_KEY]: next };
    if (mode === "push") view.history.pushState(state, "", pageLink(next.at(-1) ?? SESSIONS_PAGE));
    else view.history.replaceState(state, "", pageLink(next.at(-1) ?? SESSIONS_PAGE));
  }, [view]);
  useEffect(() => {
    if (!enabled) return;
    // Seed the entries a handed link skipped, so back from it reaches the sessions list.
    // A startup route (the handed link, consumed before mount) names the first page outright.
    const handed = initialPage.current;
    initialPage.current = undefined;
    const entry = stackOfEntry(view.history.state, view.location.hash);
    const initial = handed && !samePage(entry.at(-1) ?? SESSIONS_PAGE, handed) ? [SESSIONS_PAGE, handed] : entry;
    const seeded = initial === entry && (view.history.state as Record<string, unknown> | null)?.[STATE_KEY] === entry;
    if (!seeded) initial.forEach((_, index) => write(initial.slice(0, index + 1), index === 0 ? "replace" : "push"));
    held.current = initial;
    setPages(initial);
    const popped = (event: PopStateEvent) => {
      if (intercept.current?.()) { write(held.current, "push"); return; }
      const next = stackOfEntry(event.state, view.location.hash);
      held.current = next;
      setPages(next);
    };
    view.addEventListener("popstate", popped);
    return () => view.removeEventListener("popstate", popped);
  }, [enabled, view, write]);
  const open = useCallback((page: PhonePage) => {
    const next = nextStack(held.current, page);
    if (!next) return;
    held.current = next.pages;
    setPages(next.pages);
    write(next.pages, next.mode);
  }, [write]);
  const back = useCallback(() => { if (held.current.length > 1) view.history.back(); }, [view]);
  return useMemo(() => ({ pages, top: pages.at(-1) ?? SESSIONS_PAGE, open, back }), [pages, open, back]);
};
