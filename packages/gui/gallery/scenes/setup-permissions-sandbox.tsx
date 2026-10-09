import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.12 and look.md §13: a sandbox that does not work here, its line with Turn the sandbox off and How to fix it open with the desktop service restart button (#1988). */
export default setupRegionScene("permissions-sandbox");
export const geometry = setupGeometry;
export const readySelector = "[data-step-status] [data-notice-tone] h5";
