import { uuidv4, type NewSessionChips } from "@agent-harness/client-runtime";
import { createContext, use, useMemo, useState, useCallback, useEffect, useRef, type ReactNode, type RefCallback } from "react";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { toast } from "../ui/toaster.js";
import type { Offer } from "../keys/key-dispatch.js";
import type { GridPane, PaneLayout, PaneSession } from "../presentation.js";
import { useSurfaces } from "../new-session/surfaces.js";
import { usePresentation, useRuntime } from "../window-context.js";
import {
  GRID_FULL,
  addNewSession,
  addPane,
  chooseChips,
  focusPane,
  focusedPane,
  paneAdditionReason,
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

interface RowSizes {
  readonly widths: Readonly<Record<string, number>>;
  measure(rowId: string, width: number | undefined): void;
}
const RowSizeContext = createContext<RowSizes | null>(null);

/** Measures the row's visible width; a retained wide layout may scroll inside it. */
export const useMeasureGridRow = (rowId: string): RefCallback<HTMLDivElement> => {
  const sizes = use(RowSizeContext);
  const measure = sizes?.measure;
  return useCallback(node => {
    if (node === null || measure === undefined) return;
    // A row not laid out yet (0) is unmeasured, so it refuses no pane.
    const update = () => measure(rowId, node.offsetWidth > 0 ? node.offsetWidth : undefined);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => { observer.disconnect(); measure(rowId, undefined); };
  }, [rowId, measure]);
};

const DragContext = createContext<readonly [string | null, (id: string | null) => void] | null>(null);

const PHONE_SPLIT_REASON = "Split needs a wide layout: at least 640px and not a short touch screen.";

const PRESENT: Offer = { status: "present" };

/** Transient grid refusals, separate from the environment notice feed. */
const RefusalContext = createContext<((message: string | undefined) => void) | null>(null);

/** Holds caption drags and the refusal toast around the window's grid controls. */
export const PaneGridProvider = ({ children }: { readonly children: ReactNode }) => {
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  const measure = useCallback((rowId: string, width: number | undefined) => setWidths(held => {
    if (held[rowId] === width) return held;
    const next = { ...held };
    if (width === undefined) delete next[rowId];
    else next[rowId] = width;
    return next;
  }), []);
  const sizes = useMemo(() => ({ widths, measure }), [widths, measure]);
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
  return <RowSizeContext value={sizes}><RefusalContext value={say}><DragContext value={carried}>{children}</DragContext></RefusalContext></RowSizeContext>;
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
  /** Whether a pane can be added to the focused row now, with a reason when it cannot fit. */
  readonly adding: Offer;
  addingBeside(paneId: string, direction: SplitDirection): Offer;
  movingBeside(paneId: string, direction: SplitDirection): Offer;
  /** Adds a pane beside the focused one, with no session, and focuses it; or says the grid is full. */
  split(direction: SplitDirection): void;
  /** Opens `session` in a pane added beside the pane `paneId` (a session shown already is focused where it is); or says the grid is full. */
  openBeside(paneId: string, direction: SplitDirection, session: PaneSession): void;
  /** Whether `session` can be opened in a new pane now: absent, with `GRID_FULL`, while that would add a pane to a grid of eight. */
  openingBeside(session: PaneSession, paneId?: string, direction?: SplitDirection): Offer;
  /** Shows `session` in the pane `paneId`, focused (a session shown already is focused where it is). */
  show(paneId: string, session: PaneSession): void;
  /** Closes the pane `paneId`, sharing its row equally. */
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
  const widths = use(RowSizeContext)?.widths ?? {};
  const runtime = useRuntime();
  const { messages } = useSurfaces();
  const say = useRefusal();
  const [dragged, drag] = use(DragContext) ?? [null, () => {}];
  return useMemo<PaneGrid>(() => {
    const rowWidth = (held: PaneLayout, paneId: string) => widths[held.rows.find(row => row.panes.some(pane => pane.id === paneId))?.id ?? ""];
    const reason = (held: PaneLayout, paneId: string, direction: SplitDirection) => paneAdditionReason(held, paneId, direction, rowWidth(held, paneId));
    const addingBeside = (paneId: string, direction: SplitDirection): Offer => {
      const message = narrow ? PHONE_SPLIT_REASON : reason(layout, paneId, direction);
      return message === undefined ? PRESENT : { status: "absent", message };
    };
    /** Makes the change, saying why it cannot fit; answers whether it was made. */
    const add = (paneId: string, direction: SplitDirection, change: (held: PaneLayout, width: number | undefined) => PaneLayout | undefined, session?: PaneSession): boolean => {
      if (narrow) { say(PHONE_SPLIT_REASON); return false; }
      let refused = false;
      let message: string | undefined;
      setLayout((held) => {
        const alreadyShown = session !== undefined && paneShowing(held, session) !== undefined;
        message = alreadyShown ? undefined : reason(held, paneId, direction);
        const next = message === undefined ? change(held, rowWidth(held, paneId)) : undefined;
        refused = next === undefined;
        return next ?? held;
      });
      say(refused ? message ?? GRID_FULL : undefined);
      return !refused;
    };
    const change = (step: (held: PaneLayout) => PaneLayout) => {
      say(undefined);
      setLayout(step);
    };
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
          const removed = removePane(held, from.id);
          const message = reason(removed, to.id, zone);
          if (message !== undefined) { say(message); return held; }
          const next = addPane(removed, to.id, zone, null, rowWidth(held, to.id));
          if (next === undefined) return held;
          return { focused: from.id, rows: next.rows.map((row) => ({ ...row, panes: row.panes.map((pane) => pane.id === next.focused ? { ...from, width: pane.width } : pane) })) };
        });
      },
      focused: focusedPane(layout),
      adding: addingBeside(layout.focused, "right"),
      addingBeside,
      movingBeside: (paneId, direction) => {
        const removed = dragged === null ? layout : removePane(layout, dragged);
        const message = narrow ? PHONE_SPLIT_REASON : reason(removed, paneId, direction);
        return message === undefined ? PRESENT : { status: "absent", message };
      },
      split: (direction) => add(layout.focused, direction, (held, width) => addPane(held, held.focused, direction, null, width)),
      openBeside: (paneId, direction, session) => add(paneId, direction, (held, width) => openBeside(held, paneId, direction, session, width), session),
      openingBeside: (session, paneId = layout.focused, direction = "right") => narrow || paneShowing(layout, session) === undefined ? addingBeside(paneId, direction) : PRESENT,
      show: (paneId, session) => change((held) => showSession(held, paneId, session)),
      close: (paneId) => change((held) => removePane(held, paneId)),
      focus: (paneId) => setLayout((held) => focusPane(held, paneId)),
      newSession: (carried) => {
        const id = uuidv4();
        let shown = id;
        change((held) => {
          let next = showNewSession(held, held.focused, carried, id);
          const surface = focusedPane(next).newSession;
          if (surface !== undefined) {
            const pending = messages.get(surface.id);
            const message = pending?.read();
            const environmentId = runtime.projections.newSession(surface).read().environment.value;
            const used = environmentId !== null && (
              message?.collisionEnvironmentId === environmentId || runtime.projections.sessionList.read().rows.some(row =>
                row.environmentId === environmentId && row.summary.id.toLowerCase() === surface.id.toLowerCase(),
              )
            );
            // A successful create owns this id: a refused first message must retry on it.
            if (used && !message?.starting && message?.environmentId == null) {
              if (pending !== undefined) {
                pending.update(message => ({ ...message, line: undefined, collisionEnvironmentId: null }));
                messages.set(id, pending);
              }
              next = showNewSession(held, held.focused, carried, id, true);
            }
          }
          shown = focusedPane(next).newSession?.id ?? id;
          return next;
        });
        return shown;
      },
      newSessionBeside: (paneId, direction, carried) => {
        const id = uuidv4();
        return add(paneId, direction, (held, width) => addNewSession(held, paneId, direction, carried, id, width)) ? id : undefined;
      },
      chooseChips: (id, choose) => setLayout((held) => chooseChips(held, id, choose)),
      refuse: (line = GRID_FULL) => say(line),
    };
  }, [layout, setLayout, say, dragged, drag, narrow, runtime, messages, widths]);
};
