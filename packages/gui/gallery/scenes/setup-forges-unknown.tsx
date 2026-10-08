import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.6 and look.md §13: a site detection cannot recognise, asking what it runs (#1849). */
export default setupRegionScene("forges-unknown");
export const geometry = setupGeometry;
export const readySelector = '[role="radiogroup"][aria-label="What the site runs"]';
