import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
export default await setupRegionScene("carry-over-after");
export const readySelector = '[aria-label="What came over"]';
/** setup-copy.md §5.3: what Bring them over brought, what did not come over and where skills live now (#1844); look.md §13.2. */
export const geometry = setupGeometry;
