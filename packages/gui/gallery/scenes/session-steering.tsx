import { productScene } from "../product-scene.js";
/** look.md §10 and §15: real steering state and aligned composer. */
export default await productScene("steering");
export const readySelector = '[aria-label="Steering message"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }, { selector: '[data-workspace-chip]', height: 22 }];
