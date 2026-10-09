import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** look.md §13 and §16, setup-copy.md §5.4: the real Your machines card asking its question, Only on this computer chosen while nothing else is paired (#1846). */
export default setupRegionScene("your-machines");
export const geometry = setupGeometry;
export const readySelector = '[data-this-computer] [role="radio"][aria-label="Only on this computer"][aria-checked="true"]';
