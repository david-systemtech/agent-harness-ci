import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
export default await setupRegionScene("browser");
export const readySelector = 'section[aria-label="Using your browser"]';
/** look.md §5.3, §12.2–12.3 and §13.2. Authoring uses a 480px frame. */
export const geometry = [...setupGeometry,
  { selector: "[data-browser-substep] > span:first-child", width: 18 },
  { selector: "[data-browser-definitions]", maxWidth: 620 },
];
