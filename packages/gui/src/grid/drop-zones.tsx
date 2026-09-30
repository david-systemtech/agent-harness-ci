import { useState } from "react";
import type { PaneSession } from "../presentation.js";
import { useDraggedRow } from "../sidebar/window-sidebar.js";
import { classes } from "../ui/classes.js";
import { usePaneGrid } from "./grid.js";
import type { SplitDirection } from "./layout.js";

/**
 * Where a session dragged from the sidebar lands on a pane
 * (docs/specs/gui.md, "The window and the sidebar": onto the grid it opens
 * at a pane's centre or splits at its edge; #407). While a session is
 * dragged, each pane is covered by three targets: its centre, which opens
 * the session there, and its right and bottom edges, which split the pane
 * that way and open the session in the new pane. A session another pane
 * shows is focused there instead. With eight panes open an edge refuses the
 * drop: the pointer shows none, and the grid's line says why. Nothing covers
 * the pane while no session is dragged.
 */

type Zone = "centre" | SplitDirection;

/** How much of the pane each edge claims; the edges are drawn after the centre, so a drop near a border is that side's. */
const ZONES: readonly { readonly zone: Zone; readonly label: string; readonly place: string }[] = [
  { zone: "centre", label: "Open here", place: "inset-0" },
  { zone: "right", label: "Open to the right", place: "inset-y-0 right-0 w-[28%]" },
  { zone: "down", label: "Open below", place: "inset-x-0 bottom-0 h-[28%]" },
];

export const DropZones = ({ paneId }: { readonly paneId: string }) => {
  const [dragged] = useDraggedRow();
  return dragged === null ? null : (
    <div className="pointer-events-none absolute inset-0 z-30">
      {ZONES.map((target) => (
        <DropZone key={target.zone} paneId={paneId} session={{ environmentId: dragged.environmentId, sessionId: dragged.summary.id }} {...target} />
      ))}
    </div>
  );
};

interface DropZoneProps {
  readonly paneId: string;
  readonly session: PaneSession;
  readonly zone: Zone;
  readonly label: string;
  readonly place: string;
}

const DropZone = ({ paneId, session, zone, label, place }: DropZoneProps) => {
  const grid = usePaneGrid();
  const [, setDragged] = useDraggedRow();
  const [over, setOver] = useState(false);
  const land = () => (zone === "centre" ? grid.show(paneId, session) : grid.openBeside(paneId, zone, session));
  return (
    <div
      aria-label={label}
      className={classes(
        "pointer-events-auto absolute flex items-center justify-center border-2 border-dashed text-xs",
        over ? "border-beam bg-wash-strong text-ink" : "border-transparent text-ink-faint",
        place,
      )}
      onDragOver={(event) => {
        if (zone !== "centre" && grid.openingBeside(session).status === "absent") {
          grid.refuse();
          return setOver(false);
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        setDragged(null);
        land();
      }}
    >
      {label}
    </div>
  );
};
