import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";
import { geometry as dockGeometry, presentation as filesPresentation } from "./dock-files.js";
export { script } from "./dock-files.js";

/** Split the real window: the owning pane is narrow even at the gallery's 1400px viewport. */
export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sidebarShown: false,
  paneLayout: {
    rows: [{ id: "row-1", height: 100, panes: [
      { id: "pane-1", width: 60, session: filesPresentation.paneLayout!.rows[0]!.panes[0]!.session },
      { id: "pane-2", width: 40, session: null },
    ] }],
    focused: "pane-1",
  },
};
export const geometry: readonly SceneGeometry[] = [
  ...dockGeometry,
  { selector: "[data-dock-sheet]", width: 480 },
  { selector: '[aria-label="Close side sheet"]', height: 24 },
];
