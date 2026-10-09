import { Activity, Fragment, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator, useGroupRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { KeysAnswered } from "../keys/key-dispatch.js";
import type { GridPane, GridRow } from "../presentation.js";
import { usePresentation } from "../window-context.js";
import { DropZones } from "./drop-zones.js";
import { InGridPane, usePaneGrid } from "./grid.js";
import { panesOf, resizeRow, resizeRows, sharesOf } from "./layout.js";
import { classes } from "../ui/classes.js";
import { EmptyPane, NewSessionPane, SessionPane } from "./session-pane.js";

/**
 * The pane grid (docs/specs/gui.md, "The seven panes and the grid"; #407):
 * the rows of session panes presentation lays out (`paneLayout`), each row
 * across the grid, each pane beside the next, parted by dividers that resize
 * them down to a pixel floor. Where each divider is left is kept as a share
 * of the row or the grid. A press or the focus anywhere in a pane focuses
 * it; the focused pane is marked, and it alone answers the window's keys
 * (`KeysAnswered`). A pane shows its session, the new-session surface
 * (#420), or the word to choose a session.
 */

/** The least a pane's width and a row's height may be, in pixels (chosen defaults): a composer and a few lines stay usable. */
const PANE_LEAST = 360;
const ROW_LEAST = 220;

const DIVIDER = "bg-transparent outline-none hover:bg-beam/30 focus-visible:bg-beam/30 data-[separator=active]:bg-beam/50";

/**
 * What a group of the grid takes to hold `shares`, by panel id, and keep the
 * ones a person leaves its dividers at (`keep`). A layout the group comes to
 * itself, as it mounts or as its panels change, is put back to `shares` when
 * it differs: a group remembers the layout it last had for each set of
 * panels, and would take that back for a set it held before (a pane closed
 * after one was added) rather than the grid's, where the space went to a
 * neighbour.
 */
const useShares = (shares: Readonly<Record<string, number>>, keep: (layout: Layout) => void) => {
  const handle = useGroupRef();
  // The shares last put back, which are put back once: a group that cannot take them does not ask again.
  const putBack = useRef<string | null>(null);
  const onLayoutChanged = (layout: Layout, { isUserInteraction, requestedLayout = layout }: LayoutChangedMeta) => {
    if (isUserInteraction) return keep(layout);
    const ids = Object.keys(shares);
    const key = JSON.stringify(shares);
    // A layout of other panels is one the group holds between two sets of them.
    if (Object.keys(requestedLayout).length !== ids.length || !ids.every((id) => id in requestedLayout) || putBack.current === key) return;
    if (ids.every((id) => Math.abs((requestedLayout[id] ?? 0) - (shares[id] ?? 0)) < 0.01)) return;
    putBack.current = key;
    queueMicrotask(() => handle.current?.setLayout(shares));
  };
  return { groupRef: handle, defaultLayout: shares, onLayoutChanged };
};

export const PaneGrid = () => {
  const { narrow } = usePhoneFrame();
  const [layout, setLayout] = usePresentation("paneLayout");
  const targets = useRef(new Map<string, HTMLDivElement>());
  const parking = useRef<HTMLDivElement>(null);
  const panes = panesOf(layout);
  const [visited, setVisited] = useState<readonly GridPane[]>([]);
  const unseen = panes.filter(pane => pane.session !== null && !visited.some(held => paneKey(held) === paneKey(pane)));
  useLayoutEffect(() => {
    if (unseen.length > 0) setVisited(held => [...held, ...unseen]);
  });
  const parked = visited.filter(held => !panes.some(pane => paneKey(pane) === paneKey(held)));
  const heights = useShares(
    sharesOf(layout.rows, (row) => row.height),
    (shares) => setLayout((held) => resizeRows(held, shares)),
  );
  const several = panesOf(layout).length > 1;
  return (
    <>
      {narrow ? <div className="min-h-0 min-w-0 flex-1">{panesOf(layout).map(pane => <div key={pane.id} hidden={pane.id !== layout.focused} className="h-full min-w-0" ref={node => { if (node !== null) targets.current.set(pane.id, node); }} />)}</div> : <Group key={layout.rows.map((row) => row.id).join(" ")} orientation="vertical" {...heights} className="h-full">
        {layout.rows.map((row, at) => (
          <Fragment key={row.id}>
            {at > 0 && <Separator aria-label="Resize the rows" className={`h-[7px] ${DIVIDER}`} />}
            <Panel id={row.id} minSize={ROW_LEAST}>
              <PaneRow row={row} place={at + 1} targets={targets} />
            </Panel>
          </Fragment>
        ))}
      </Group>}
      <div hidden ref={parking} />
      {[...panes, ...parked].map(pane => <MountedPane key={paneKey(pane)} pane={pane} parked={parked.includes(pane)} parking={parking} focused={!parked.includes(pane) && pane.id === layout.focused} several={several && !narrow} targets={targets} />)}
    </>
  );
};

const paneKey = (pane: GridPane) => pane.session === null ? pane.id : `${pane.session.environmentId} ${pane.session.sessionId}`;

type PaneTargets = RefObject<Map<string, HTMLDivElement>>;

/** A row of the grid, named by its place from the top. */
const PaneRow = ({ row, place, targets }: { readonly row: GridRow; readonly place: number; readonly targets: PaneTargets }) => {
  const [, setLayout] = usePresentation("paneLayout");
  const widths = useShares(
    sharesOf(row.panes, (pane) => pane.width),
    (shares) => setLayout((held) => resizeRow(held, row.id, shares)),
  );
  return (
    <Group key={row.panes.map((pane) => pane.id).join(" ")} role="group" aria-label={`Row ${place}`} {...widths} className="h-full">
      {row.panes.map((pane, at) => (
        <Fragment key={pane.id}>
          {at > 0 && <Separator aria-label="Resize the panes" className={`w-[7px] ${DIVIDER}`} />}
          <Panel id={pane.id} minSize={PANE_LEAST}>
            <div className="h-full" ref={(node) => { if (node !== null) targets.current.set(pane.id, node); }} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
};

/**
 * Keep session contents in one keyed list, independent of panes, rows and resizer groups.
 * A group rebuilds its constraints when its panel order changes; only its empty
 * targets remount. Moving the same portal host preserves unsent attachments,
 * file selections and every other local pane state, including across rows.
 * Visited sessions stay in a hidden Activity when replaced in a pane, retaining
 * unsent attachments while releasing their effects and subscriptions.
 */
const MountedPane = ({ pane, targets, parked, parking, ...contents }: { readonly pane: GridPane; readonly targets: PaneTargets; readonly parked: boolean; readonly parking: RefObject<HTMLDivElement | null>; readonly focused: boolean; readonly several: boolean }) => {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "h-full";
    return element;
  });
  useLayoutEffect(() => {
    const target = parked ? parking.current : targets.current.get(pane.id);
    if (target != null && host.parentNode !== target) target.appendChild(host);
  });
  useLayoutEffect(() => () => { host.remove(); }, [host]);
  return createPortal(<Activity mode={parked ? "hidden" : "visible"}><GridPaneView pane={pane} {...contents} /></Activity>, host);
};

/**
 * One pane of the grid: focused by a press or the focus inside it, answering the window's keys while it is.
 * Its card clips what overflows it: a hidden-overflow box still scrolls when a browser reveals a focused
 * control or runs a scrollIntoView, and no reader can scroll it back (#1948).
 */
const GridPaneView = ({ pane, focused, several }: { readonly pane: GridPane; readonly focused: boolean; readonly several: boolean }) => {
  const grid = usePaneGrid();
  const contents = { focused, marked: focused && several, close: several ? () => grid.close(pane.id) : undefined };
  return (
    <InGridPane id={pane.id}>
      <KeysAnswered answered={focused}>
        <div data-grid-card={pane.id} className={classes("relative flex h-full min-w-0 flex-col overflow-clip rounded-lg border bg-panel", focused && several ? "border-beam/55" : "border-hairline")} onPointerDown={() => grid.focus(pane.id)} onFocus={() => grid.focus(pane.id)}>
          {pane.session !== null ? (
            <SessionPane session={pane.session} {...contents} />
          ) : pane.newSession !== undefined ? (
            <NewSessionPane surface={pane.newSession} {...contents} />
          ) : (
            <EmptyPane {...contents} />
          )}
          <DropZones paneId={pane.id} />
        </div>
      </KeysAnswered>
    </InGridPane>
  );
};
