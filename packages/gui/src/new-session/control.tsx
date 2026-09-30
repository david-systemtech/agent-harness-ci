import type { DragEvent, ReactNode } from "react";
import { GRID_FULL, type SplitDirection } from "../grid/layout.js";
import { usePaneGrid } from "../grid/grid.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import { useSettings } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useSurfaces, type NewSessionControl } from "./surfaces.js";
import { OFF_GRID } from "./words.js";

/**
 * The New session controls (docs/specs/gui.md, "The window and the sidebar"
 * and "A new session"; story 28; #420): the header's, and each environment
 * heading's in the sidebar. A click, or the header's `app.session.new`
 * (Mod+N), shows the new-session surface in the focused pane, the session it
 * showed staying in the sidebar; `app.session.newInPane` (Mod+Shift+N, and
 * the palette's "New session in a new pane") opens it in a pane split right
 * from the focused one. Every control drags too, carried as
 * `NEW_SESSION_DRAG_TYPE` alone so a text field it is dropped on takes
 * nothing in: onto the grid it opens the surface in a new pane
 * (`grid/drop-zones.tsx`), and dropped anywhere else it is refused, the
 * grid's line saying why. At eight panes every way of adding a pane is
 * refused with the grid's reason. A heading's control carries its
 * environment; the header's the focused pane's. Settings, over the grid,
 * gives the window back to the grid as a surface is shown, whose message box
 * takes the focus.
 */

/** The drag data a New session control carries: the environment it carries, as JSON. */
export const NEW_SESSION_DRAG_TYPE = "application/x-agent-harness-new-session";

export interface StartNewSession {
  /** Shows the surface in the focused pane for the environment the control carries. */
  here(control: NewSessionControl): void;
  /** Opens the surface in a pane added beside the pane `paneId`; refused at eight panes, the grid's line saying why. */
  beside(paneId: string, direction: SplitDirection, control: NewSessionControl): void;
}

/** What a New session control does, wherever it is. */
export const useStartNewSession = (): StartNewSession => {
  const grid = usePaneGrid();
  const settings = useSettings();
  const { askFocus } = useSurfaces();
  const shown = (id: string | undefined) => {
    if (id === undefined) return;
    settings.close();
    askFocus(id);
  };
  return {
    here: (control) => shown(grid.newSession(control.environmentId)),
    beside: (paneId, direction, control) => shown(grid.newSessionBeside(paneId, direction, control.environmentId)),
  };
};

/** What a control takes to be dragged: a drag that ends anywhere but on the grid is refused, the grid's line saying why. */
const useDragControl = (control: NewSessionControl) => {
  const grid = usePaneGrid();
  const { setDragged, draggedNow } = useSurfaces();
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(NEW_SESSION_DRAG_TYPE, JSON.stringify(control));
      event.dataTransfer.effectAllowed = "copy";
      setDragged(control);
    },
    onDragEnd: () => {
      // A drop on the grid has taken it already.
      if (draggedNow() === null) return;
      setDragged(null);
      grid.refuse(grid.adding.status === "absent" ? GRID_FULL : OFF_GRID);
    },
  };
};

interface NewSessionButtonProps {
  readonly control: NewSessionControl;
  /** Its accessible name and tooltip. */
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/** A New session control: a click shows the surface in the focused pane, and it drags onto the grid. */
export const NewSessionButton = ({ control, label, className, children }: NewSessionButtonProps) => {
  const start = useStartNewSession();
  return (
    <Button aria-label={label} title={label} className={className} onClick={() => start.here(control)} {...useDragControl(control)}>
      {children}
    </Button>
  );
};

const HEADER_CONTROL: NewSessionControl = { environmentId: null };

/** The header's New session control, with the window's keys for a new session. */
export const HeaderNewSession = () => {
  const grid = usePaneGrid();
  const start = useStartNewSession();
  useKeyAction("app.session.new", () => start.here(HEADER_CONTROL));
  useKeyAction("app.session.newInPane", () => start.beside(grid.focused.id, "right", HEADER_CONTROL), grid.adding);
  return (
    <NewSessionButton control={HEADER_CONTROL} label="New session" className="h-7 px-2 text-xs">
      New session
    </NewSessionButton>
  );
};
