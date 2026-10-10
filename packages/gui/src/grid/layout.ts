import type { NewSessionChips, NewSessionFocus } from "@agent-harness/client-runtime";
import { PANES_MOST, type GridPane, type GridRow, type PaneLayout, type PaneSession } from "../presentation.js";

/**
 * How the pane grid changes (docs/specs/gui.md, "The seven panes and the
 * grid"; #407): rows of session panes, eight at most, the layout
 * presentation keeps (`paneLayout`). Right grows the pane's row; down adds a
 * row across the grid under the pane's row, so a third pane under a pair
 * spans the window rather than quartering it. A pane closed gives its space
 * to its neighbour, a row with it when it was the row's last, and the grid
 * keeps at least one pane. A session shows in one pane at a time: opening
 * one already shown focuses its pane. A pane shows a session, the
 * new-session surface (#420), or neither. Each function takes the layout
 * held and answers the next, the same one when nothing changes.
 */

/** What each way of adding a pane says while the grid holds eight. */
export const GRID_FULL = "The grid holds eight panes; close one first.";

/** Where a pane is added beside another: after it in its row, or in a row of its own under the pane's row. */
export type SplitDirection = "right" | "down";

/** Every pane of the grid, row by row, left to right. */
export const panesOf = (layout: PaneLayout): readonly GridPane[] => layout.rows.flatMap((row) => row.panes);

/** Whether the grid holds eight panes, so no pane can be added. */
export const isFull = (layout: PaneLayout): boolean => panesOf(layout).length >= PANES_MOST;

/** The focused pane. */
export const focusedPane = (layout: PaneLayout): GridPane => {
  const panes = panesOf(layout);
  return panes.find((pane) => pane.id === layout.focused) ?? (panes[0] as GridPane);
};

/** The pane showing `session` (its id read whatever its case); undefined while none does. */
export const paneShowing = (layout: PaneLayout, session: PaneSession): GridPane | undefined =>
  panesOf(layout).find((pane) => pane.session?.environmentId === session.environmentId && pane.session.sessionId.toLowerCase() === session.sessionId.toLowerCase());

const holds = (layout: PaneLayout, paneId: string): boolean => panesOf(layout).some((pane) => pane.id === paneId);

/** Focuses the pane `paneId`; one the grid does not hold changes nothing. */
export const focusPane = (layout: PaneLayout, paneId: string): PaneLayout => (layout.focused === paneId || !holds(layout, paneId) ? layout : { ...layout, focused: paneId });

/**
 * Shows `session` in the pane `paneId` (the focused one, once the grid no
 * longer holds it) and focuses that pane; a session another pane shows
 * already is focused there instead.
 */
export const showSession = (layout: PaneLayout, paneId: string, session: PaneSession): PaneLayout => {
  const showing = paneShowing(layout, session);
  if (showing !== undefined) return focusPane(layout, showing.id);
  return showIn(layout, paneId, () => ({ session }));
};

/** What a pane shows: a session, a new-session surface, or neither. */
type PaneContents = Pick<GridPane, "session" | "newSession">;

/** The pane `paneId` (the focused one, once the grid no longer holds it) showing what `contents` makes of its own, focused. */
const showIn = (layout: PaneLayout, paneId: string, contents: (pane: GridPane) => Partial<PaneContents>): PaneLayout => {
  const target = holds(layout, paneId) ? paneId : layout.focused;
  const shown = (pane: GridPane): GridPane => {
    const { session = null, newSession } = contents(pane);
    return { id: pane.id, width: pane.width, session, ...(newSession !== undefined && { newSession }) };
  };
  return { rows: layout.rows.map((row) => ({ ...row, panes: row.panes.map((pane) => (pane.id === target ? shown(pane) : pane)) })), focused: target };
};

/**
 * The environment a pane is on: its session's; for its new-session surface,
 * the environment chosen on it, else the one it was opened for; null for a
 * pane on none.
 */
export const paneEnvironment = ({ session, newSession }: GridPane): string | null => {
  if (session !== null) return session.environmentId;
  if (newSession === undefined) return null;
  return newSession.chips.environmentId ?? ("environmentId" in newSession.focus ? newSession.focus.environmentId : null);
};

/**
 * What a new-session surface's chips preset from (docs/specs/gui.md, "The
 * window and the sidebar"; #420): the environment the New session control
 * carries (a heading's own; `null`, the header's, the focused pane's), and
 * the workspace of the pane `besideId` it lands beside while that pane shows
 * a session on that environment: that session in focus, whose environment
 * and workspace the picker presets. Beside a pane on another environment,
 * or none, the environment alone, the picker presetting the workspace; with
 * no environment, nothing, the picker's whole rule.
 */
export const newSessionFocus = (layout: PaneLayout, carried: string | null, besideId: string): NewSessionFocus => {
  const environmentId = carried ?? paneEnvironment(focusedPane(layout));
  const beside = panesOf(layout).find((pane) => pane.id === besideId)?.session;
  if (beside != null && beside.environmentId === environmentId) return { kind: "session", ...beside };
  return environmentId === null ? { kind: "none" } : { kind: "environment", environmentId };
};

/**
 * Shows a new-session surface in the pane `paneId` (the focused one, once
 * the grid no longer holds it), under the id `id`, preset beside that pane
 * for the environment `carried` (`newSessionFocus`), and focuses it; the
 * session it showed stays in the sidebar. A pane holding one already keeps
 * it, with what was chosen on it: a heading's control (`carried`) sets its
 * environment chip, the chips after it following, and the header's changes
 * nothing. A used id is replaced when `replaceId` is set, keeping the choices.
 */
export const showNewSession = (layout: PaneLayout, paneId: string, carried: string | null, id: string, replaceId = false): PaneLayout =>
  showIn(layout, paneId, (pane) => {
    if (pane.newSession === undefined) return { newSession: { id, focus: newSessionFocus(layout, carried, pane.id), chips: {} } };
    const chips: NewSessionChips = carried === null ? pane.newSession.chips : { ...pane.newSession.chips, environmentId: carried };
    return { newSession: { ...pane.newSession, id: replaceId ? id : pane.newSession.id, chips } };
  });

/** An id no row or pane holds: `row-n` or `pane-n`, n past the highest the grid holds by `after` and one. */
const freshId = (layout: PaneLayout, kind: "row" | "pane", after = 0): string => {
  const numbers = layout.rows.flatMap((row) => [row.id, ...row.panes.map((pane) => pane.id)]).map((id) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0));
  return `${kind}-${Math.max(0, ...numbers) + 1 + after}`;
};

/**
 * Adds a pane beside the pane `paneId`, showing `session` (none by default),
 * and focuses it: `right` puts it after the pane in its row, the two sharing
 * the pane's width; `down` puts a row across the grid under the pane's row,
 * the two rows sharing its height. Undefined while the grid holds eight
 * panes, or holds no pane `paneId`.
 */
export const addPane = (layout: PaneLayout, paneId: string, direction: SplitDirection, session: PaneSession | null = null): PaneLayout | undefined =>
  addBeside(layout, paneId, direction, { session });

/**
 * Adds a pane beside the pane `paneId` as `addPane` does, holding a
 * new-session surface under the id `id`, preset beside that pane for the
 * environment `carried` (`newSessionFocus`), and focuses it; no pane's
 * session is replaced. Undefined while the grid holds eight panes, or holds
 * no pane `paneId`.
 */
export const addNewSession = (layout: PaneLayout, paneId: string, direction: SplitDirection, carried: string | null, id: string): PaneLayout | undefined =>
  addBeside(layout, paneId, direction, { session: null, newSession: { id, focus: newSessionFocus(layout, carried, paneId), chips: {} } });

const addBeside = (layout: PaneLayout, paneId: string, direction: SplitDirection, contents: PaneContents): PaneLayout | undefined => {
  if (isFull(layout) || !holds(layout, paneId)) return undefined;
  const added: GridPane = { id: freshId(layout, "pane"), width: 100, ...contents };
  const rows = layout.rows.flatMap((row): GridRow[] => {
    const at = row.panes.findIndex((pane) => pane.id === paneId);
    const beside = row.panes[at];
    if (beside === undefined) return [row];
    if (direction === "down") {
      const height = row.height / 2;
      return [{ ...row, height }, { id: freshId(layout, "row", 1), panes: [added], height }];
    }
    const width = beside.width / 2;
    return [{ ...row, panes: [...row.panes.slice(0, at), { ...beside, width }, { ...added, width }, ...row.panes.slice(at + 1)] }];
  });
  return { rows, focused: added.id };
};

/**
 * Opens `session` in a pane added beside the pane `paneId` (`addPane`); a
 * session another pane shows already is focused there instead, and nothing
 * is added. Undefined when a pane would be added to a grid of eight.
 */
export const openBeside = (layout: PaneLayout, paneId: string, direction: SplitDirection, session: PaneSession): PaneLayout | undefined => {
  const showing = paneShowing(layout, session);
  return showing === undefined ? addPane(layout, paneId, direction, session) : focusPane(layout, showing.id);
};

/**
 * Closes the pane `paneId`. Its width goes to its neighbour in its row, the
 * pane before it (after it, for the first); a row it leaves empty goes, its
 * height to the row above (below, for the first). The focus, when it was on
 * the pane closed, moves to the pane that took its space (the first of the
 * row that did). The grid's last pane is not closed.
 */
export const removePane = (layout: PaneLayout, paneId: string): PaneLayout => {
  const r = layout.rows.findIndex((row) => row.panes.some((pane) => pane.id === paneId));
  const row = layout.rows[r];
  if (row === undefined || panesOf(layout).length <= 1) return layout;
  const heir = (id: string) => (layout.focused === paneId ? id : layout.focused);
  if (row.panes.length > 1) {
    const at = row.panes.findIndex((pane) => pane.id === paneId);
    const closed = row.panes[at] as GridPane;
    const n = at === 0 ? 1 : at - 1;
    const neighbour = row.panes[n] as GridPane;
    const panes = row.panes.flatMap((pane, index) => (index === at ? [] : index === n ? [{ ...pane, width: pane.width + closed.width }] : [pane]));
    return { rows: layout.rows.map((held, index) => (index === r ? { ...held, panes } : held)), focused: heir(neighbour.id) };
  }
  const n = r === 0 ? 1 : r - 1;
  const neighbour = layout.rows[n] as GridRow;
  const rows = layout.rows.flatMap((held, index) => (index === r ? [] : index === n ? [{ ...held, height: held.height + row.height }] : [held]));
  return { rows, focused: heir((neighbour.panes[0] as GridPane).id) };
};

/**
 * The new-session surface `id` with what `change` makes of its chips; a
 * layout holding no such surface is the same one.
 */
export const chooseChips = (layout: PaneLayout, id: string, change: (chips: NewSessionChips) => NewSessionChips): PaneLayout => {
  if (!panesOf(layout).some((pane) => pane.newSession?.id === id)) return layout;
  const chosen = (pane: GridPane): GridPane => (pane.newSession?.id === id ? { ...pane, newSession: { ...pane.newSession, chips: change(pane.newSession.chips) } } : pane);
  return { ...layout, rows: layout.rows.map((row) => ({ ...row, panes: row.panes.map(chosen) })) };
};

/** Each part's share by its id: a row's panes' widths, or the rows' heights, as the dividers' layout. */
export const sharesOf = <P extends { readonly id: string }>(parts: readonly P[], share: (part: P) => number): Readonly<Record<string, number>> =>
  Object.fromEntries(parts.map((part) => [part.id, share(part)]));

/** Whether `shares` holds a share for each of `parts` and for nothing else. */
const fits = (parts: readonly { readonly id: string }[], shares: Readonly<Record<string, number>>): boolean =>
  parts.length === Object.keys(shares).length && parts.every((part) => Number.isFinite(shares[part.id]));

/** The row `rowId`'s panes at the widths its dividers were left at, by pane id; widths for other panes change nothing. */
export const resizeRow = (layout: PaneLayout, rowId: string, widths: Readonly<Record<string, number>>): PaneLayout => ({
  ...layout,
  rows: layout.rows.map((row) => (row.id !== rowId || !fits(row.panes, widths) ? row : { ...row, panes: row.panes.map((pane) => ({ ...pane, width: widths[pane.id] ?? pane.width })) })),
});

/** The rows at the heights their dividers were left at, by row id; heights for other rows change nothing. */
export const resizeRows = (layout: PaneLayout, heights: Readonly<Record<string, number>>): PaneLayout =>
  fits(layout.rows, heights) ? { ...layout, rows: layout.rows.map((row) => ({ ...row, height: heights[row.id] ?? row.height })) } : layout;
