import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.4 and look.md §13: Your machines' never-polled container line with How to set it up open beside it (#1883). */
export default setupRegionScene("host-updater");
export const geometry = setupGeometry;
export const readySelector = "[data-host-updater-setup]";
