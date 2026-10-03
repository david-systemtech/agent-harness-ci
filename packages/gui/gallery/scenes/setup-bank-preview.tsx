import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
export default await setupRegionScene("bank-preview");
export const readySelector = '[data-join-preview]';
/** look.md §5.3, §12.2–12.3 and §13.2. Authoring uses a 480px frame. */
export const geometry = [...setupGeometry,
  { selector: "[data-join-preview]", maxWidth: 620 },
  { selector: "[data-join-preview] > header", paddingLeft: 12, paddingTop: 8 },
];
