import { productScene } from "../product-scene.js";
/** look.md §10 and §15: real queue state and aligned composer. */
export default await productScene("queue");
export const readySelector = '[aria-label="Queued message"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }, { selector: '[data-workspace-chip]', height: 22 }];
