import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.11 connected: every step ticked and Use my Chrome for agents chosen. look.md §5.3, §12.2–12.3 and §13.2. */
export default await setupRegionScene("browser");
export const readySelector = "[data-browser-after]";
export const geometry = [...setupGeometry,
  { selector: "[data-browser-substep] > span:first-child", width: 18 },
];
