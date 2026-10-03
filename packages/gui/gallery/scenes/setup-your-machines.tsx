import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** look.md §13 and §16: the real Your machines card with persistent step navigation. */
export default setupRegionScene("your-machines");
export const geometry = setupGeometry;
export const readySelector = 'nav[aria-label="Set up steps"] button[aria-current="step"][aria-label="Your machines"]';
