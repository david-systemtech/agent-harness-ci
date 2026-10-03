import { useState } from "react";
import { useStartNewSession } from "../new-session/control.js";
import { useDraggedControl } from "../new-session/surfaces.js";
import type { PaneSession } from "../presentation.js";
import { useDraggedRow } from "../sidebar/window-sidebar.js";
import { classes } from "../ui/classes.js";
import { usePaneGrid } from "./grid.js";
import { GRID_FULL, type SplitDirection } from "./layout.js";

/**
 * Where a session dragged from the sidebar, or a New session control, lands
 * on a pane (docs/specs/gui.md, "The window and the sidebar": onto the grid
 * a session opens at a pane's centre or splits at its edge; #407, #420).
 * While either is dragged, each pane is covered by three targets: its
 * centre and its right and bottom edges. A session opens in the pane at its
 * centre, and at an edge splits the pane that way and opens in the new one;
 * a session another pane shows is focused there instead. A New session
 * control never replaces a session: at an edge it splits that pane, and at
 * a centre it splits the focused pane right, the new pane holding the
 * new-session surface. With eight panes open every target that would add a
 * pane refuses the drop: the pointer shows none, and a transient toast says
 * why. Nothing covers the pane while nothing is dragged.
 */

type Zone = "centre" | SplitDirection;

/** How much of the pane each edge claims; the edges are drawn after the centre, so a drop near a border is that side's. */
const PLACES: Readonly<Record<Zone, string>> = {
  centre: "inset-0",
  right: "inset-y-0 right-0 w-[28%]",
  down: "inset-x-0 bottom-0 h-[28%]",
};
const ZONES: readonly Zone[] = ["centre", "right", "down"];

const SESSION_LABELS: Readonly<Record<Zone, string>> = { centre: "Open here", right: "Open to the right", down: "Open below" };
const PANE_LABELS: Readonly<Record<Zone, string>> = { centre: "Swap panes", right: "Move to the right", down: "Move below" };
const NEW_SESSION_LABELS: Readonly<Record<Zone, string>> = { centre: "New session beside the focused pane", right: "New session to the right", down: "New session below" };

/** What a target does with the drop: whether it refuses it, adding a pane to a grid of eight, and what landing does. */
interface Landing {
  readonly refused: boolean;
  land(): void;
}

export const DropZones = ({ paneId }: { readonly paneId: string }) => {
  const [row, setRow] = useDraggedRow();
  const [control, setControl] = useDraggedControl();
  const grid = usePaneGrid();
  const start = useStartNewSession();
  if (grid.dragged !== null) {
    if (grid.dragged === paneId) return null;
    return <Zones labels={PANE_LABELS} landing={(zone) => ({ refused: false, land: () => grid.move(paneId, zone) })} effect="move" />;
  }
  if (row !== null) {
    const session: PaneSession = { environmentId: row.environmentId, sessionId: row.summary.id };
    const landing = (zone: Zone): Landing => ({
      refused: zone !== "centre" && grid.openingBeside(session).status === "absent",
      land: () => {
        setRow(null);
        if (zone === "centre") grid.show(paneId, session);
        else grid.openBeside(paneId, zone, session);
      },
    });
    return <Zones labels={SESSION_LABELS} landing={landing} effect="move" />;
  }
  if (control !== null) {
    const landing = (zone: Zone): Landing => ({
      refused: grid.adding.status === "absent",
      land: () => {
        setControl(null);
        if (zone === "centre") start.beside(grid.focused.id, "right", control);
        else start.beside(paneId, zone, control);
      },
    });
    return <Zones labels={NEW_SESSION_LABELS} landing={landing} effect="copy" />;
  }
  return null;
};

const Zones = ({ labels, landing, effect }: { readonly labels: Readonly<Record<Zone, string>>; landing(zone: Zone): Landing; readonly effect: "move" | "copy" }) => (
  <div className="pointer-events-none absolute inset-0 z-30">
    {ZONES.map((zone) => (
      <DropZone key={zone} label={labels[zone]} place={PLACES[zone]} landing={landing(zone)} effect={effect} />
    ))}
  </div>
);

interface DropZoneProps {
  readonly label: string;
  readonly place: string;
  /** Whether a drop here is refused, and what it does. */
  readonly landing: Landing;
  readonly effect: "move" | "copy";
}

const DropZone = ({ label, place, landing, effect }: DropZoneProps) => {
  const grid = usePaneGrid();
  const [over, setOver] = useState(false);
  return (
    <div
      data-drop-zone
      aria-label={label}
      className={classes(
        "pointer-events-auto absolute flex items-center justify-center text-2xs",
        over ? "bg-beam/15 ring-2 ring-inset ring-beam/50 text-ink" : "text-ink-faint",
        place,
      )}
      onDragOver={(event) => {
        if (landing.refused) {
          grid.refuse();
          return setOver(false);
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = effect;
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (landing.refused) grid.refuse();
        else landing.land();
      }}
    >
      <span data-drop-label className="max-w-full rounded-md border border-dashed border-beam/70 bg-panel px-3 py-1.5 shadow-lg shadow-scrim/40">{landing.refused ? GRID_FULL : label}</span>
    </div>
  );
};
