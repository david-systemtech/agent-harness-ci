import { dialogGeometry } from "../dialog-scene.js";
import type { SceneViewport } from "../scene-registry.js";
import { setupRegionScene } from "../setup-regions-scene.js";

/** look.md §11.1, #1690, setup-copy.md §5.2: the sign-in dialog from Set up's Account step, waiting for the code, its numbered steps unfolded. */
export default setupRegionScene("sign-in");
export const geometry = (viewport: SceneViewport) => [
  ...dialogGeometry(512)(viewport),
  // The title, close X and both actions stay in the window however short it is; the middle scrolls.
  { selector: '[role="dialog"]', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] h2', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] button[aria-label="Close dialog"]', visibleWithin: '[role="dialog"]' },
  { selector: "[data-sign-in-footer] button", visibleWithin: '[role="dialog"]' },
];
export const readySelector = '[role="dialog"] form[aria-label="Send the code"]';
