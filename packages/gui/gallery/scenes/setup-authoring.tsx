import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
export default await setupRegionScene("authoring");
export const readySelector = '[data-authoring-frame] [aria-label="Transcript"]';
/** look.md §5.3, §12.2–12.3 and §13.2. Authoring uses a 480px frame. */
export const geometry = [...setupGeometry,
  { selector: "[data-authoring-frame]", height: 480, maxWidth: 620 },
  { selector: "[data-authoring-frame] header", paddingLeft: 12, paddingTop: 8 },
];
