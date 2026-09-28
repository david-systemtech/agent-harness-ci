import { createContext, use, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Conditions } from "../keys/key-dispatch.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import { Button } from "../ui/index.js";

/**
 * The find bar (docs/specs/gui.md, "A session pane": a find bar, Mod+F;
 * "Keyboard": `app.find`, and `transcript.findNext`, `findPrevious` and
 * `findClose` while it has the keys). Every text the transcript draws is
 * drawn through `Marked` (or, as markdown, through the `findMarks` plugin),
 * which marks each match of the query, ignoring case, with `<mark>`; the bar
 * counts the marks drawn, walks them in the order they are drawn, marks the
 * one it is on as current and scrolls to it. So what the find bar finds is
 * what the transcript shows: a fold's calls are found once it is unfolded.
 * Closed, it keeps what it looked for, offered again the next time it opens.
 */

/** The find bar's query, trimmed; empty while the bar is closed or nothing is typed. */
export const FindQuery = createContext("");

/** `text` cut at each match of `query`, ignoring case: the pieces between, and the matches. */
const matchesIn = (text: string, query: string): readonly { readonly text: string; readonly match: boolean }[] => {
  if (query === "") return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const pieces: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) pieces.push({ text: text.slice(from, at), match: false });
    pieces.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), match: false });
  return pieces;
};

/** Text, with each match of the find bar's query marked. */
export const Marked = ({ text }: { readonly text: string }): ReactNode => {
  const query = use(FindQuery);
  if (query === "") return text;
  return matchesIn(text, query).map((piece, index) => (piece.match ? <mark key={index}>{piece.text}</mark> : piece.text));
};

/** A node of the tree markdown is rendered from (hast), as much of it as the marking reads. */
interface TreeNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  children?: TreeNode[];
}

const markText = (node: TreeNode, query: string): void => {
  if (node.children === undefined || node.tagName === "mark") return;
  node.children = node.children.flatMap((child): TreeNode[] => {
    if (child.type !== "text" || child.value === undefined) {
      markText(child, query);
      return [child];
    }
    return matchesIn(child.value, query).map((piece) =>
      piece.match ? { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: piece.text }] } : { type: "text", value: piece.text },
    ) as TreeNode[];
  });
};

/** A rehype plugin marking each match of `query` in rendered markdown, code included. */
export const findMarks =
  (query: string) =>
  () =>
  (tree: unknown): void =>
    markText(tree as TreeNode, query);

export interface FindBarState {
  readonly open: boolean;
  /** What is typed in the bar. */
  readonly query: string;
  /** What the transcript marks: the query, trimmed, while the bar is open. */
  readonly marked: string;
  /** The conditions of the transcript's keys: `transcript.finding` holds while the bar is open and has the focus. */
  readonly conditions: Conditions;
  readonly field: RefObject<HTMLInputElement | null>;
  readonly bar: RefObject<HTMLDivElement | null>;
  /** What the bar says of its matches: which one of how many, or that there are none. */
  readonly status: string;
  show(): void;
  close(): void;
  type(query: string): void;
  step(by: 1 | -1): void;
}

/**
 * The find bar over the marks drawn in `column`: open or shut, what it looks
 * for, and which match it is on. Going to a match stops the transcript
 * following its end (`stopFollowing`), so a stream does not take the reader
 * away from it.
 */
export const useFindBar = (column: RefObject<HTMLElement | null>, stopFollowing: () => void): FindBarState => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  /** How many times it has been asked for: each asking puts the caret in the field again, what was typed selected. */
  const [asked, setAsked] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const marked = open ? query.trim() : "";
  const at = count === 0 ? -1 : Math.min(index, count - 1);

  // The marks drawn are counted, and the one the bar is on is marked current: after every render of the transcript, and
  // whenever a row draws itself again on its own while the bar looks (a fold opened or shut), which the transcript never hears.
  const recount = useCallback(() => {
    const marks = column.current?.querySelectorAll("mark") ?? [];
    setCount(marks.length);
    const current = marks.length === 0 ? -1 : Math.min(index, marks.length - 1);
    marks.forEach((mark, place) => (place === current ? mark.setAttribute("aria-current", "true") : mark.removeAttribute("aria-current")));
  }, [column, index]);
  useLayoutEffect(recount);
  useEffect(() => {
    const content = column.current;
    if (marked === "" || content === null) return;
    // Only what is drawn is watched, not the attributes the count itself sets.
    const observer = new MutationObserver(recount);
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [column, marked, recount]);
  // Going to a match: when what is looked for or the step changes, never when a stream draws the transcript again.
  useLayoutEffect(() => {
    if (marked === "") return;
    const mark = column.current?.querySelectorAll("mark")[index];
    if (mark === undefined) return;
    stopFollowing();
    // jsdom has no scrolling into view; a window does.
    if (typeof mark.scrollIntoView === "function") mark.scrollIntoView({ block: "center" });
  }, [column, stopFollowing, marked, index]);
  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    field.current?.select();
  }, [open, asked]);

  const show = useCallback(() => {
    if (!open && document.activeElement instanceof HTMLElement) returnTo.current = document.activeElement;
    setOpen(true);
    setAsked((times) => times + 1);
  }, [open]);
  const close = useCallback(() => {
    setOpen(false);
    returnTo.current?.focus();
  }, []);
  const type = useCallback((next: string) => {
    setQuery(next);
    setIndex(0);
  }, []);
  const step = useCallback((by: 1 | -1) => setIndex(count === 0 ? 0 : (Math.max(at, 0) + by + count) % count), [at, count]);

  const status = marked === "" ? "" : count === 0 ? "No matches" : `${at + 1} of ${count}`;
  const conditions: Conditions = { "transcript.finding": () => open && bar.current !== null && bar.current.contains(document.activeElement) };
  return { open, query, marked, conditions, field, bar, status, show, close, type, step };
};

/** The find bar's keys: `app.find` from anywhere in the window, and while the bar has the keys, the next and previous match and closing it. */
export const FindKeys = ({ find }: { readonly find: FindBarState }) => {
  useKeyAction("app.find", find.show);
  useKeyAction("transcript.findNext", () => find.step(1));
  useKeyAction("transcript.findPrevious", () => find.step(-1));
  useKeyAction("transcript.findClose", find.close);
  return null;
};

/** The bar itself, over the transcript's top edge, so opening it moves nothing David is reading. */
export const FindBar = ({ find }: { readonly find: FindBarState }) => (
  <div
    ref={find.bar}
    role="search"
    aria-label="Find in the conversation"
    className="absolute top-2 right-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border border-line-strong bg-float px-1.5 py-1 text-xs"
  >
    <input
      ref={find.field}
      type="search"
      aria-label="Find"
      placeholder="Find in the conversation"
      spellCheck={false}
      value={find.query}
      onChange={(event) => find.type(event.target.value)}
      className="h-6 w-44 min-w-0 shrink bg-transparent text-ink outline-none placeholder:text-ink-faint"
    />
    <span aria-live="polite" className="min-w-16 shrink-0 text-right text-ink-muted tabular-nums">
      {find.status}
    </span>
    <Button aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => find.step(-1)} className="h-6 px-1.5">
      ↑
    </Button>
    <Button aria-label="Next match" title="Next match (Enter)" onClick={() => find.step(1)} className="h-6 px-1.5">
      ↓
    </Button>
    <Button aria-label="Close find" title="Close (Esc)" onClick={find.close} className="h-6 px-1.5">
      ✕
    </Button>
  </div>
);
