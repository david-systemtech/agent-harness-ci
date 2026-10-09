import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.12: a paired computer keeps the sandbox restart command to copy (#1988). */
export default setupRegionScene("permissions-sandbox-paired");
export const geometry = setupGeometry;
export const readySelector = "[data-step-status] [data-notice-tone] h5";
