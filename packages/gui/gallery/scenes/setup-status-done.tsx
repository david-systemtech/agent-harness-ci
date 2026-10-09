import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §3: a done step's status, its state word, its line and its Details shut, one Check again and Open in Settings (#1840). */
export default setupRegionScene("status-done");
export const geometry = setupGeometry;
export const readySelector = "[data-step-status] [data-state-badge=done]";
