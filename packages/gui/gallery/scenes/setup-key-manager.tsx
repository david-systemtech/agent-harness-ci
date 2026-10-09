import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.7, look.md §13 and §16: the real Key manager card asking Which one do you use?, I do not use one chosen (#1851). */
export default setupRegionScene("key-manager");
export const geometry = setupGeometry;
export const readySelector = '[data-setup-scroll] [role="radiogroup"]';
