import { useKeyAction } from "../keys/key-dispatch.js";
import { usePaneGrid } from "./grid.js";

/**
 * The header's split actions (docs/specs/gui.md, "The window and the
 * sidebar": the header holds the split actions), with their keys,
 * `app.pane.splitRight` (Mod+\) and `app.pane.splitDown` (Mod+Shift+\): each
 * adds a pane beside the focused one, to its right in its row or in a row
 * across the grid under it, and focuses it. With eight panes open each is
 * refused, the grid's line saying why, and the palette draws it dim with
 * that reason.
 */
export const SplitActions = () => {
  const grid = usePaneGrid();
  useKeyAction("app.pane.splitRight", () => grid.split("right"), grid.adding);
  useKeyAction("app.pane.splitDown", () => grid.split("down"), grid.adding);
  return null;
};
