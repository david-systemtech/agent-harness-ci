import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.7 and look.md §13: the Key manager card with a key manager that does not answer: its health in one line with Check again (#1851). */
export default setupRegionScene("key-manager-unreachable");
export const geometry = setupGeometry;
export const readySelector = '[data-setup-scroll] [data-connection-health="unreachable"]';
