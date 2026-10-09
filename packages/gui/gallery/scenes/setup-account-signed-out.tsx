import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.1 (#1842): the real Account card with an account signed out, and Claude Code on this computer signed out. */
export default setupRegionScene("account-signed-out");
export const geometry = setupGeometry;
export const readySelector = '[data-ambient-signed-out]';
