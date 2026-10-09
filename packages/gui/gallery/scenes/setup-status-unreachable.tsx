import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §3, the patterns: this app cannot reach the computer, with Try again, its results marked as maybe out of date (#1840). */
export default setupRegionScene("status-unreachable");
export const geometry = setupGeometry;
export const readySelector = "[data-reach-line] button";
