import { setupPaneScene } from "../setup-pane-scene.js";
import { setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §4.5: Check everything again opens the first step needing a fix and explains the jump above its notice. */
export default await setupPaneScene("needs-fix");
export const geometry = [
  ...setupGeometry,
  { selector: "[data-setup-checked]", visibleWithin: "[data-setup-scroll]", unbroken: true },
  { selector: "[data-step-status] [data-notice-tone=warning]", below: "[data-setup-checked]", visibleWithin: "[data-setup-scroll]" },
];
export const readySelector = "[data-setup-checked]";
