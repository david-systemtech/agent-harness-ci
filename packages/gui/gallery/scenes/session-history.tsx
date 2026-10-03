import { productScene } from "../product-scene.js";
/** look.md §10 and §15: real history state and aligned composer. */
export default await productScene("history");
export const readySelector = '[aria-label="Latest rewind"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }, { selector: '[data-workspace-chip]', height: 22 }];
