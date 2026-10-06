import { dialogGeometry } from "../dialog-scene.js";
import type { SceneViewport } from "../scene-registry.js";
import { setupRegionScene } from "../setup-regions-scene.js";

/** look.md §11.1, #1690: the provider sign-in dialog from Set up's Account step, waiting for the code. */
export default setupRegionScene("sign-in");
export const geometry = (viewport: SceneViewport) => [
  ...dialogGeometry(512)(viewport),
  // The title, close X and both actions stay in the window however short it is; the middle scrolls.
  { selector: '[role="dialog"]', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] h2', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] button[aria-label="Close dialog"]', visibleWithin: '[role="dialog"]' },
  { selector: "[data-sign-in-footer] button", visibleWithin: '[role="dialog"]' },
  // From 800px tall the folded link leaves nothing to scroll.
  ...(viewport.height >= 800 ? [{ selector: "[data-sign-in-body]", contentFits: true }] : []),
];
export const readySelector = '[role="dialog"] form[aria-label="Send the code"]';
