import { createContext, use, useMemo, useState, type ReactNode } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import type { GridPane, PaneLayout, PaneSession } from "../presentation.js";
import { usePresentation } from "../window-context.js";
import { GRID_FULL, addPane, focusPane, focusedPane, isFull, openBeside, paneShowing, removePane, showSession, type SplitDirection } from "./layout.js";

/**
 * The pane grid's gestures (docs/specs/gui.md, "The seven panes and the
 * grid"; #407), over the layout presentation keeps (`paneLayout`, changed as
 * `layout.ts` says): what the header's split actions, a pane's caption, a
 * drop on the grid and the sidebar's Open in a new pane do. A way of adding
 * a pane to a grid of eight is refused, and the grid's line in the header
 * says why; the next gesture that does something clears it.
 */

const PRESENT: Offer = { status: "present" };

/** The grid's line: what it last refused, and the setter that says another (undefined clears it). */
const LineContext = createContext<readonly [string | undefined, (line: string | undefined) => void] | null>(null);

/** The window's grid line, held around the header and the grid. */
export const PaneGridProvider = ({ children }: { readonly children: ReactNode }) => {
  const [line, say] = useState<string | undefined>(undefined);
  const held = useMemo(() => [line, say] as const, [line]);
  return <LineContext value={held}>{children}</LineContext>;
};

const useLine = () => {
  const line = use(LineContext);
  if (line === null) throw new Error("The pane grid is changed inside the window's frame, which holds its line.");
  return line;
};

/** The grid's line in the header: what it last refused. */
export const GridLine = () => {
  const [line] = useLine();
  return line === undefined ? null : (
    <p role="status" className="px-2 text-xs text-ink-muted">
      {line}
    </p>
  );
};

/** The id of the grid pane a component is drawn in; none outside one (the header, the sidebar, the palette). */
const PaneIdContext = createContext<string | null>(null);

/** Marks the part of the window drawn in the grid pane `id`. */
export const InGridPane = ({ id, children }: { readonly id: string; readonly children: ReactNode }) => <PaneIdContext value={id}>{children}</PaneIdContext>;

/** The id of the grid pane the component is drawn in; null outside one. */
export const useGridPaneId = (): string | null => use(PaneIdContext);

/** Whether the component is drawn in the focused pane, or outside the grid. */
export const useInFocusedPane = (): boolean => {
  const id = useGridPaneId();
  const [layout] = usePresentation("paneLayout");
  return id === null || layout.focused === id;
};

export interface PaneGrid {
  readonly focused: GridPane;
  /** Whether a pane can be added now: absent, with `GRID_FULL`, while the grid holds eight. */
  readonly adding: Offer;
  /** Adds a pane beside the focused one, with no session, and focuses it; or says the grid is full. */
  split(direction: SplitDirection): void;
  /** Opens `session` in a pane added beside the pane `paneId` (a session shown already is focused where it is); or says the grid is full. */
  openBeside(paneId: string, direction: SplitDirection, session: PaneSession): void;
  /** Whether `session` can be opened in a new pane now: absent, with `GRID_FULL`, while that would add a pane to a grid of eight. */
  openingBeside(session: PaneSession): Offer;
  /** Shows `session` in the pane `paneId`, focused (a session shown already is focused where it is). */
  show(paneId: string, session: PaneSession): void;
  /** Closes the pane `paneId`, its space going to its neighbour. */
  close(paneId: string): void;
  /** Focuses the pane `paneId`. */
  focus(paneId: string): void;
  /** Says the grid is full: a gesture that would add a pane was refused. */
  refuse(): void;
}

/** The grid as presentation holds it, and its gestures. */
export const usePaneGrid = (): PaneGrid => {
  const [layout, setLayout] = usePresentation("paneLayout");
  const [, say] = useLine();
  return useMemo<PaneGrid>(() => {
    /** Makes the change, saying the grid is full when it cannot be made. */
    const add = (change: (held: PaneLayout) => PaneLayout | undefined) => {
      let refused = false;
      setLayout((held) => {
        const next = change(held);
        refused = next === undefined;
        return next ?? held;
      });
      say(refused ? GRID_FULL : undefined);
    };
    const change = (step: (held: PaneLayout) => PaneLayout) => {
      say(undefined);
      setLayout(step);
    };
    const full: Offer = { status: "absent", message: GRID_FULL };
    return {
      focused: focusedPane(layout),
      adding: isFull(layout) ? full : PRESENT,
      split: (direction) => add((held) => addPane(held, held.focused, direction)),
      openBeside: (paneId, direction, session) => add((held) => openBeside(held, paneId, direction, session)),
      openingBeside: (session) => (isFull(layout) && paneShowing(layout, session) === undefined ? full : PRESENT),
      show: (paneId, session) => change((held) => showSession(held, paneId, session)),
      close: (paneId) => change((held) => removePane(held, paneId)),
      focus: (paneId) => setLayout((held) => focusPane(held, paneId)),
      refuse: () => say(GRID_FULL),
    };
  }, [layout, setLayout, say]);
};
