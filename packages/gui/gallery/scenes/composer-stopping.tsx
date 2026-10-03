import { productScene } from "../product-scene.js";
/** look.md §10 and §15: real stopping state and aligned composer. */
export default await productScene("stopping");
export const readySelector = 'button[aria-label="Stopping…"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }, { selector: '[data-workspace-chip]', height: 22 }];
