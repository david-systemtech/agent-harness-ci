import type { SessionProjection } from "@agent-harness/client-runtime";
import { useMemo, useRef } from "react";
import type { Box } from "./box.js";

/** The prompts sent in the session that a run read, newest first: what ↑ walks. */
const promptsOf = (projection: SessionProjection): readonly string[] =>
  projection.items.flatMap((entry) => (entry.kind === "user-message" && entry.delivery !== "queued" && entry.text.length > 0 ? [entry.text] : [])).reverse();

/** A walk through the session's prompts, alive while the box holds what it put there. */
interface Walk {
  readonly texts: readonly string[];
  /** -1 is the text the walk began from; 0 the newest prompt. */
  readonly position: number;
  readonly origin: string;
  readonly shown: string;
}

/**
 * `composer.navigate` (docs/specs/gui.md, "Keyboard: the GUI column"): ↑ and
 * ↓ from the start of the box walk the prompts sent in the session, newest
 * first, and back to what was there; the window keeps no history of its own,
 * so the session's transcript is the history. The caret stays at the start,
 * so the next ↑ or ↓ walks on. A key with nowhere to go is declined.
 */
export const usePromptWalk = (projection: SessionProjection, box: Box): ((key: number) => false | void) => {
  const prompts = useMemo(() => promptsOf(projection), [projection]);
  const walk = useRef<Walk | null>(null);
  return (key) => {
    const text = box.current();
    const current = walk.current !== null && walk.current.shown === text ? walk.current : { texts: prompts, position: -1, origin: text, shown: text };
    // The column's first key (↑) goes back, its second (↓) forward.
    const position = Math.min(Math.max(current.position + (key === 0 ? 1 : -1), -1), current.texts.length - 1);
    if (position === current.position) return false;
    const shown = position === -1 ? current.origin : (current.texts[position] ?? current.origin);
    walk.current = { ...current, position, shown };
    box.put(shown, 0);
  };
};
