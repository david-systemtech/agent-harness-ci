import type { PresentationValues } from "../../src/presentation.js";
import { presentation as layout } from "../caption-pull-requests-scene.js";
export { script, activate, readySelector } from "../caption-pull-requests-scene.js";
import { geometry as checks } from "../caption-pull-requests-scene.js";
export const geometry = checks.map(check => check.selector === "[data-caption-title] button" ? { ...check, contentFits: false } : check);
export const presentation: Partial<PresentationValues> = { textSize: 20, paneLayout: {
  focused: "pane-1", rows: [{ id: "row-1", height: 100, panes: layout.paneLayout!.rows.flatMap(row => row.panes.map(pane => ({ ...pane, width: 50 }))) }],
} };
