/**
 * Where Tab goes and where the transcript's cursor steps, carried from
 * Artemis's `keymap.ts` (docs/specs/tui.md, "The screen"): the ring Tab walks
 * (`app.focus.next`) and the cursor step the transcript's ↑ and ↓ make
 * (`transcript.cursor`), both pure, so the map's rows and the code that makes
 * them true are one edit apart. The terminal pane is the one stop the harness
 * adds. The screens that take the focus wire them as they arrive.
 */

/** The places the keyboard can be, in the order Tab walks them. */
export type Focus = "composer" | "sidebar" | "delegated" | "terminal" | "transcript";

/** Which stops on the ring exist right now. The composer and the transcript always do. */
export interface FocusStops {
  /** False on a terminal too narrow for the rail, which is then not drawn. */
  readonly sidebar: boolean;
  /** False whenever nothing is delegated; the strip is not drawn either. */
  readonly delegated: boolean;
  /** True while a terminal pane is open. */
  readonly terminal: boolean;
}

/**
 * The next stop after `current`, skipping the ones that are not there: the
 * composer, the rail, the delegated strip, the terminal pane, the transcript.
 * A focus whose stop has just gone is off the ring, and the step leads to
 * the composer, the one stop that is always there.
 */
export const nextFocus = (current: Focus, stops: FocusStops): Focus => {
  const ring: Focus[] = ["composer"];
  if (stops.sidebar) ring.push("sidebar");
  if (stops.delegated) ring.push("delegated");
  if (stops.terminal) ring.push("terminal");
  ring.push("transcript");
  const at = ring.indexOf(current);
  return ring[(at + 1) % ring.length] ?? "composer";
};

/**
 * Where ↑ or ↓ takes the transcript's cursor, given the rows on screen:
 * clamped rather than wrapped; a cursor that is nowhere, or on a row no
 * longer drawn, lands on the last row whichever arrow was pressed, since the
 * viewport is anchored to the bottom; null only when there are no rows.
 */
export const stepCursor = (rows: readonly string[], current: string | null, delta: number): string | null => {
  if (rows.length === 0) return null;
  const at = current === null ? -1 : rows.indexOf(current);
  if (at === -1) return rows[rows.length - 1] ?? null;
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))] ?? null;
};
