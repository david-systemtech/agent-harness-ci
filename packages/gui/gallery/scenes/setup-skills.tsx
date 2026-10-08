import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.9 and look.md §13: the Skills step's catalogue, one collection added, the rest with Add (#1855). */
export default setupRegionScene("skills");
export const geometry = setupGeometry;
export const readySelector = 'section[aria-label="Unslop"] button';
