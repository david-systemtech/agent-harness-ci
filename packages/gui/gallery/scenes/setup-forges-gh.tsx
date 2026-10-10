import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.6 and look.md §13: the Forges card offering this computer's gh first, above Add a forge and a forge's row (#1849). */
export default setupRegionScene("forges-gh");
export const geometry = setupGeometry;
export const readySelector = '[data-gh-route="use"]';
