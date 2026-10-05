import { uuidv4, type NewSessionChips } from "@agent-harness/client-runtime";
import { createContext, use, useMemo, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { toast } from "../ui/toaster.js";
import type { Offer } from "../keys/key-dispatch.js";
import type { GridPane, PaneLayout, PaneSession } from "../presentation.js";
import { usePresentation } from "../window-context.js";
import {
  GRID_FULL,
  addNewSession,
  addPane,
  chooseChips,
  focusPane,
  focusedPane,
  isFull,
  openBeside,
  paneShowing,
  removePane,
  showNewSession,
  showSession,
  type SplitDirection,
} from "./layout.js";

/**
 * The pane grid's gestures (docs/specs/gui.md, "The seven panes and the
 * grid"; #407), over the layout presentation keeps (`paneLayout`, changed as
 * `layout.ts` says): what the header's split actions, a pane's caption, a
 * drop on the grid and the sidebar's Open in a new pane do, and the New
 * session controls (#420). A way of adding a pane to a grid of eight is
 * refused, and a transient toast says why; the next gesture that
 * does something clears it.
 */

const DragContext = createContext<readonly [string | null, (id: string | null) => void] | null>(null);

const PHONE_SPLIT_REASON = "Split needs a wide layout: at least 640px and not a short touch screen.";

const PRESENT: Offer = { status: "present" };

/** Transient grid refusals, separate from the environment notice feed. */
const RefusalContext = createContext<((message: string | undefined) => void) | null>(null);

/** Holds caption drags and the refusal toast around the window's grid controls. */
export const PaneGridProvider = ({ children }: { readonly children: ReactNode }) => {
  const [dragged, drag] = useState<string | null>(null);
  const carried = useMemo(() => [dragged, drag] as const, [dragged]);
  const currentToast = useRef<string | number | null>(null);
  const say = useCallback((message: string | undefined) => {
    if (message === undefined) {
      if (currentToast.current !== null) toast.dismiss(currentToast.current);
      currentToast.current = null;
      return;
    }
    const id = toast.warning(message, {
      ...(currentToast.current !== null && { id: currentToast.current }),
      onDismiss: ({ id }) => { if (currentToast.current === id) currentToast.current = null; },
      onAutoClose: ({ id }) => { if (currentToast.current === id) currentToast.current = null; },
    });
    currentToast.current = id;
  }, []);
  useEffect(() => () => { if (currentToast.current !== null) toast.dismiss(currentToast.current); }, []);
  return <RefusalContext value={say}><DragContext value={carried}>{children}</DragContext></RefusalContext>;
};

const useRefusal = () => {
  const say = use(RefusalContext);
  if (say === null) throw new Error("The pane grid is changed inside the window's frame, which holds its feedback.");
  return say;
};

/** Compatibility for the header until it removes its grid line; refusals now use the transient toast lane. */
export const GridLine = () => null;

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
  readonly dragged: string | null;
  move(paneId: string, zone: "centre" | SplitDirection): void;
  drag(id: string | null): void;
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
  /**
   * Shows a new-session surface in the focused pane for the environment
   * `carried` (null: the focused pane's), preset beside that pane
   * (`showNewSession`); answers its id.
   */
  newSession(carried: string | null): string;
  /**
   * Adds a pane beside the pane `paneId` holding a new-session surface for
   * the environment `carried`, preset beside that pane (`addNewSession`);
   * answers its id, or undefined when the grid is full, and says so.
   */
  newSessionBeside(paneId: string, direction: SplitDirection, carried: string | null): string | undefined;
  /** Changes the chips chosen on the new-session surface `id`. */
  chooseChips(id: string, change: (chips: NewSessionChips) => NewSessionChips): void;
  /** Says why a gesture that would add a pane was refused: preset, that the grid is full. */
  refuse(line?: string): void;
}

/** The grid as presentation holds it, and its gestures. */
export const usePaneGrid = (): PaneGrid => {
  const { narrow } = usePhoneFrame();
  const [layout, setLayout] = usePresentation("paneLayout");
  const say = useRefusal();
  const [dragged, drag] = use(DragContext) ?? [null, () => {}];
  return useMemo<PaneGrid>(() => {
    /** Makes the change, saying the grid is full when it cannot be made; answers whether it was made. */
    const add = (change: (held: PaneLayout) => PaneLayout | undefined): boolean => {
      if (narrow) { say(PHONE_SPLIT_REASON); return false; }
      let refused = false;
      setLayout((held) => {
        const next = change(held);
        refused = next === undefined;
        return next ?? held;
      });
      say(refused ? GRID_FULL : undefined);
      return !refused;
    };
    const change = (step: (held: PaneLayout) => PaneLayout) => {
      say(undefined);
      setLayout(step);
    };
    const full: Offer = { status: "absent", message: GRID_FULL };
    return {
      dragged, drag,
      move: (paneId, zone) => {
        drag(null);
        if (narrow) { say(PHONE_SPLIT_REASON); return; }
        change((held) => {
          const from = held.rows.flatMap((row) => row.panes).find((pane) => pane.id === dragged);
          const to = held.rows.flatMap((row) => row.panes).find((pane) => pane.id === paneId);
          if (from === undefined || to === undefined || from.id === to.id) return held;
          if (zone === "centre") return {
            focused: from.id,
            rows: held.rows.map((row) => ({ ...row, panes: row.panes.map((pane) => pane.id === from.id ? { ...to, width: pane.width } : pane.id === to.id ? { ...from, width: pane.width } : pane) })),
          };
          const next = addPane(removePane(held, from.id), to.id, zone);
          if (next === undefined) return held;
          return { focused: from.id, rows: next.rows.map((row) => ({ ...row, panes: row.panes.map((pane) => pane.id === next.focused ? { ...from, width: pane.width } : pane) })) };
        });
      },
      focused: focusedPane(layout),
      adding: narrow ? { status: "absent", message: PHONE_SPLIT_REASON } : isFull(layout) ? full : PRESENT,
      split: (direction) => add((held) => addPane(held, held.focused, direction)),
      openBeside: (paneId, direction, session) => add((held) => openBeside(held, paneId, direction, session)),
      openingBeside: (session) => narrow ? { status: "absent", message: PHONE_SPLIT_REASON } : (isFull(layout) && paneShowing(layout, session) === undefined ? full : PRESENT),
      show: (paneId, session) => change((held) => showSession(held, paneId, session)),
      close: (paneId) => change((held) => removePane(held, paneId)),
      focus: (paneId) => setLayout((held) => focusPane(held, paneId)),
      newSession: (carried) => {
        const id = uuidv4();
        let shown = id;
        change((held) => {
          const next = showNewSession(held, held.focused, carried, id);
          shown = focusedPane(next).newSession?.id ?? id;
          return next;
        });
        return shown;
      },
      newSessionBeside: (paneId, direction, carried) => {
        const id = uuidv4();
        return add((held) => addNewSession(held, paneId, direction, carried, id)) ? id : undefined;
      },
      chooseChips: (id, choose) => setLayout((held) => chooseChips(held, id, choose)),
      refuse: (line = GRID_FULL) => say(line),
    };
  }, [layout, setLayout, say, dragged, drag, narrow]);
};
