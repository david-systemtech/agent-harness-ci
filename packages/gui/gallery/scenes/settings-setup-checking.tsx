import { settingsGeometry } from "../settings-scene.js";
import { setupPaneScene } from "../setup-pane-scene.js";
/** setup-copy.md §4.5: Check everything again running, busy and disabled (#1841). */
export default await setupPaneScene("checking");
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane] button[aria-busy="true"]';
