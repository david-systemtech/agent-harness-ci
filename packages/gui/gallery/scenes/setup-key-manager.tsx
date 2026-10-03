import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** look.md §13 and §16: the real Key manager card with persistent step navigation. */
export default setupRegionScene("key-manager");
export const geometry = setupGeometry;
export const readySelector = 'nav[aria-label="Set up steps"] button[aria-current="step"][aria-label="Key manager"]';
