import { setupRegionScene } from "../setup-regions-scene.js";
/** look.md §13.2: leaving without an account asks once, above the real checklist. */
export default setupRegionScene("close-confirmation");
export const readySelector = '[role="dialog"]';
export const geometry = [{ selector: '[role="dialog"]', width: 384 }];
