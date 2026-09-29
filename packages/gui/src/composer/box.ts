import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** The composer's box: its text and caret, and the changes the composer makes to them. */
export interface Box {
  readonly field: RefObject<HTMLTextAreaElement | null>;
  readonly text: string;
  /** Where the caret was last seen: the menus open by it. */
  readonly caret: number;
  /** The text as the box holds it now, a key typed since the last render included. */
  current(): string;
  /** Replaces the text, the caret at `at` (its end unless said; null where the typing left it). */
  put(next: string, at?: number | null): void;
  /** Types `chars` over the selection. */
  insert(chars: string): void;
  /** The caret moved (a click, an arrow key). */
  moved(): void;
}

/**
 * The box's text and caret: the text is the composer's until it is sent, and
 * a change made here (a newline, a draft taken, a path chosen) puts the caret
 * where the change says once it is drawn. The caret is followed as it moves,
 * since the menus open by where it is.
 */
export const useBox = (): Box => {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const placing = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (placing.current === null || field.current === null) return;
    field.current.setSelectionRange(placing.current, placing.current);
    setCaret(placing.current);
    placing.current = null;
  });
  const current = () => field.current?.value ?? text;
  const put = (next: string, at: number | null = next.length) => {
    placing.current = at;
    setText(next);
    if (at === null) setCaret(field.current?.selectionStart ?? next.length);
  };
  return {
    field,
    text,
    caret,
    current,
    put,
    insert(chars) {
      const now = current();
      const start = field.current?.selectionStart ?? now.length;
      const end = field.current?.selectionEnd ?? start;
      put(now.slice(0, start) + chars + now.slice(end), start + chars.length);
    },
    moved: () => setCaret(field.current?.selectionStart ?? 0),
  };
};
