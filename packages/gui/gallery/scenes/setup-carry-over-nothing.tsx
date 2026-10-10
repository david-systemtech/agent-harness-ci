import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
export default await setupRegionScene("carry-over-nothing");
export const readySelector = "[data-carry-over-nothing]";
/** setup-copy.md §5.3: nothing to bring over is two lines (#1844); look.md §13.2. */
export const geometry = setupGeometry;
