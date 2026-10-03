import { PaneGrid } from "../grid/pane-grid.js";
import { PaneLines } from "../session/pane-line.js";

/**
 * The session pane region (docs/specs/gui.md, "The seven panes and the
 * grid"): the pane grid, up to eight session panes in rows, each showing the
 * session presentation holds for it (`paneLayout`) or saying none is open
 * (`grid/`). It keeps the lines handed to a pane a session is about to open
 * in (`useOpenInPane`).
 */
export const SessionPaneRegion = () => (
  <PaneLines>
    <main className="flex h-full min-w-0 flex-col bg-panel">
      <PaneGrid />
    </main>
  </PaneLines>
);
