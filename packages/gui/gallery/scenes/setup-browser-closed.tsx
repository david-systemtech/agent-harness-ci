import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.11: a paired Chrome closed, its line with no Unpair beside it (#1857). */
export default setupRegionScene("browser-closed");
export const readySelector = '[role="img"][aria-label="Step 5: done"]';
export const geometry = [...setupGeometry,
  { selector: "[data-browser-substep] > span:first-child", width: 18 },
];
