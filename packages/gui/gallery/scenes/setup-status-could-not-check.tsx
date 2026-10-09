import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §3, the patterns: a check that could not run as Set up opened, with Check again and Details (#1840). */
export default setupRegionScene("status-could-not-check");
export const geometry = setupGeometry;
export const readySelector = "[data-step-status] [data-notice-tone=error]";
