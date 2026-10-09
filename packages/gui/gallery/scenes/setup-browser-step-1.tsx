import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.11: nothing done yet, steps 1 to 4 and no code (#1857). */
export default setupRegionScene("browser-step-1");
export const readySelector = 'ol[aria-label="Connect Chrome"] pre';
export const geometry = [...setupGeometry,
  { selector: "[data-browser-substep] > span:first-child", width: 18 },
];
