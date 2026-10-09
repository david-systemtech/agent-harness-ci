import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.4 and look.md §13: Your machines answered "Also from my other devices" with Tailscale not installed, Get Tailscale and Check again (#1846). */
export default setupRegionScene("machines-unreachable");
export const geometry = setupGeometry;
export const readySelector = '[data-reach-verdict="not-installed"]';
