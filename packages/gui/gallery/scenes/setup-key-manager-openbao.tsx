import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.7 and look.md §13: the Key manager card with OpenBao's connect form chosen: the address with its hint and How do you sign in? with a token chosen (#1851). */
export default setupRegionScene("key-manager-openbao");
export const geometry = setupGeometry;
export const readySelector = '[data-setup-scroll] form[aria-label="Connect OpenBao"]';
