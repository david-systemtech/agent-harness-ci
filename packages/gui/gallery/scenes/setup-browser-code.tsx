import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.11: Chrome found the extension, step 5 with its code and minutes left (#1857). */
export default setupRegionScene("browser-code");
export const readySelector = 'input[aria-label="Pairing code"]';
export const geometry = [...setupGeometry,
  { selector: "[data-browser-substep] > span:first-child", width: 18 },
];
