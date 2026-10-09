import { MenuShortcut } from "../ui/menu.js";
import { Plus, SquarePlus } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { GRID_FULL, type SplitDirection } from "../grid/layout.js";
import { usePaneGrid } from "../grid/grid.js";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { useFirstKey, useKeyAction } from "../keys/key-dispatch.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, MenuItem, Tooltip, type ButtonProps } from "../ui/index.js";
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
 * and on a phone the session drawer, give the window back to the grid as a
 * surface is shown, whose message box takes the focus (#1902).
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
  const phone = usePhoneFrame();
  const { askFocus } = useSurfaces();
  const shown = (id: string | undefined) => {
    if (id === undefined) return;
    settings.close();
    if (phone.narrow) phone.showDrawer(false, { restoreFocus: false });
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

type NewSessionButtonProps = Omit<ButtonProps, "aria-label" | "title" | "onClick"> & {
  readonly control: NewSessionControl;
  /** Its accessible name and tooltip. */
  readonly label: string;
  readonly children: ReactNode;
};

/** A New session control: a click shows the surface in the focused pane, and it drags onto the grid. */
export const NewSessionButton = ({ control, label, children, ...props }: NewSessionButtonProps) => {
  const start = useStartNewSession();
  return (
    <Button {...props} aria-label={label} title={label} onClick={() => start.here(control)} {...useDragControl(control)}>
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
  return null;
};

/** The menu keeps the draggable New session control and offers a new pane separately. */
export const HeaderNewSessionItems = ({ select, onDragStart, onDragEnd }: { readonly select: (run: () => void) => void; readonly onDragStart: () => void; readonly onDragEnd: () => void }) => {
  const grid = usePaneGrid();
  const start = useStartNewSession();
  const drag = useDragControl(HEADER_CONTROL);
  const hereKeys = useFirstKey("app.session.new");
  const paneKeys = useFirstKey("app.session.newInPane");
  const absent = grid.adding.status === "absent" ? grid.adding.message : undefined;
  return <>
    <Tooltip content="New session" keys={hereKeys}>
      <MenuItem aria-label="New session" onSelect={() => select(() => start.here(HEADER_CONTROL))} {...drag} onDragStart={(event) => { onDragStart(); drag.onDragStart(event); }} onDragEnd={() => { drag.onDragEnd(); onDragEnd(); }}>
        <Plus aria-hidden="true" />New session<MenuShortcut>{hereKeys}</MenuShortcut>
      </MenuItem>
    </Tooltip>
    <Tooltip content={["New session in a new pane", absent].filter(Boolean).join(" · ")} keys={paneKeys}>
      <MenuItem aria-label="New session in a new pane" disabled={absent !== undefined} onSelect={() => select(() => start.beside(grid.focused.id, "right", HEADER_CONTROL))}>
        <SquarePlus aria-hidden="true" /><span>New session in a new pane{absent !== undefined && <span className="block text-xs text-ink-faint">{absent}</span>}</span><MenuShortcut>{paneKeys}</MenuShortcut>
      </MenuItem>
    </Tooltip>
  </>;
};
