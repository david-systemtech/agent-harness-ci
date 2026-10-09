import { settingsGeometry } from "../settings-scene.js";
import { setupPaneScene } from "../setup-pane-scene.js";
/** setup-copy.md §4.5: Check everything again found every step fine, a step not set up among them (#1841). */
export default await setupPaneScene("passed");
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane] p[role="status"]';
