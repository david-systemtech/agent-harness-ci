import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.4 and look.md §13: Your machines answered "Also from my other devices", reachable through Tailscale, then Add a device (#1846). */
export default setupRegionScene("machines-tailscale");
export const geometry = setupGeometry;
export const readySelector = '[data-reach-verdict="reachable"]';
