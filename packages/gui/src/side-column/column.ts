import { useCallback } from "react";
import { sideColumnKey, type PaneSession, type SideColumn, type SidePane } from "../presentation.js";
import { usePresentation } from "../window-context.js";
import { DOCK_PANES } from "./panes.js";

/**
 * A session's side column as presentation keeps it (docs/specs/gui.md, "The
 * seven panes and the grid"): which panes are open, the one shown, and
 * whether the column is hidden, and how each gesture changes them. A pane is
 * closed only by its close button; showing another, hiding the column or
 * opening another session leaves it open, hidden. Pure but for the hook.
 */

/** A session with no pane open. */
export const NO_COLUMN: SideColumn = Object.freeze({ open: Object.freeze([]), shown: null, hidden: false });

/** How many sessions' columns are kept: the ones changed longest ago go first (a chosen default). */
const KEPT = 200;

/** Shows `pane`, adding it to the open panes when it is not open, and the column with it. */
export const showPane = (column: SideColumn, pane: SidePane): SideColumn => ({
  open: column.open.includes(pane) ? column.open : [...column.open, pane],
  shown: pane,
  hidden: false,
});

/** Closes `pane`: the rail loses it, and the pane after it shows in its place, else the one before. */
export const closePane = (column: SideColumn, pane: SidePane): SideColumn => {
  const ordered = DOCK_PANES.filter((kind) => column.open.includes(kind));
  const at = ordered.indexOf(pane);
  if (at === -1) return column;
  const open = ordered.filter((other) => other !== pane);
  const shown = column.shown === pane ? (open[at] ?? open[at - 1] ?? null) : column.shown;
  return { open, shown, hidden: open.length > 0 && column.hidden };
};

/** Hides the column, or shows it again with the pane it showed; a column with no pane open has nothing to hide. */
export const hideColumn = (column: SideColumn, hidden: boolean): SideColumn => (column.open.length === 0 ? column : { ...column, hidden });

/** Every session's columns with `key`'s changed to `column`, kept last; one with no pane open is let go of. */
const withColumn = (columns: Readonly<Record<string, SideColumn>>, key: string, column: SideColumn): Readonly<Record<string, SideColumn>> => {
  const others = Object.entries(columns).filter(([other]) => other !== key);
  return Object.fromEntries((column.open.length > 0 ? [...others, [key, column] as const] : others).slice(-KEPT));
};

/** The session's side column, and a change to it: a gesture's step from the column held when it runs. */
export const useSideColumn = (session: PaneSession): readonly [SideColumn, (step: (column: SideColumn) => SideColumn) => void] => {
  const [columns, setColumns] = usePresentation("sideColumns");
  const key = sideColumnKey(session);
  const change = useCallback(
    (step: (column: SideColumn) => SideColumn) =>
      setColumns((held) => {
        const before = held[key] ?? NO_COLUMN;
        const after = step(before);
        return after === before ? held : withColumn(held, key, after);
      }),
    [setColumns, key],
  );
  return [columns[key] ?? NO_COLUMN, change] as const;
};
