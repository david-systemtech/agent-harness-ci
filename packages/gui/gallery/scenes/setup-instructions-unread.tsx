import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.10 and look.md §13: the Instructions line naming the steps of the parts it could not read, with Go to each (#1856). */
export default setupRegionScene("instructions-unread");
export const geometry = setupGeometry;
export const readySelector = "[data-go-to-steps]";
