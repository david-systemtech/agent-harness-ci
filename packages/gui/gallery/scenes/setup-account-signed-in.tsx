import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.1 (#1842): the real Account card with an account signed in, its row with its label, email and state. */
export default setupRegionScene("account-signed-in");
export const geometry = setupGeometry;
export const readySelector = '[data-account-card]';
