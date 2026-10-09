import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.7 and look.md §13: the Key manager card with a key manager connected: its health line and switch, More options shut, and Move saved tokens (#1851). */
export default setupRegionScene("key-manager-connected");
export const geometry = setupGeometry;
export const readySelector = '[data-setup-scroll] [data-move-saved-tokens]';
