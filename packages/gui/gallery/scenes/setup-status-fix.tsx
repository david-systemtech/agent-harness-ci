import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §3: a step needing a fix as a notice, its named actions and Check again in place, its Details open (#1840). */
export default setupRegionScene("status-fix");
export const geometry = setupGeometry;
export const readySelector = "[data-step-status] [data-notice-tone=warning] button[aria-expanded=true]";
