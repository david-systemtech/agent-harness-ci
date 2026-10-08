import { settingsGeometry } from "../settings-scene.js";
import { setupPaneScene } from "../setup-pane-scene.js";
/** setup-copy.md §4.5: Check everything again could not check desk, the alert with Details (#1841). */
export default await setupPaneScene("refused");
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane] [data-notice-tone="error"]';
