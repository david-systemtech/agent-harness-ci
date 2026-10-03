import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** look.md §13 and §16: the real Appearance card with persistent step navigation. */
export default setupRegionScene("appearance");
export const geometry = setupGeometry;
export const readySelector = 'nav[aria-label="Set up steps"] button[aria-current="step"][aria-label="Appearance"]';
