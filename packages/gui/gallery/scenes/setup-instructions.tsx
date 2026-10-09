import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** look.md §13 and §16, setup-copy.md §5.10: the real Instructions card, Your note, Suggestions and the fold, with persistent step navigation. */
export default setupRegionScene("instructions");
export const geometry = setupGeometry;
export const readySelector = "[data-setup-suggestions]";
