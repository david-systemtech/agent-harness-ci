import { dialogGeometry } from "../dialog-scene.js";
import type { SceneViewport } from "../scene-registry.js";
import { setupRegionScene } from "../setup-regions-scene.js";

/** setup-copy.md §5.2, #1843: the sign-in dialog kept open after Claude refused the code, with Start again and Details. */
export default setupRegionScene("sign-in-refused");
export const geometry = (viewport: SceneViewport) => [
  ...dialogGeometry(512)(viewport),
  { selector: '[role="dialog"]', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] h2', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] [data-notice-tone="error"]', visibleWithin: '[role="dialog"]' },
  { selector: "[data-sign-in-footer] button", visibleWithin: '[role="dialog"]' },
];
export const readySelector = '[role="dialog"] [data-notice-tone="error"]';
