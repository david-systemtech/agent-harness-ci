import { settingsGeometry } from "../settings-scene.js";
import { setupPaneScene } from "../setup-pane-scene.js";
/** look.md §12 and §16; setup-copy.md §4.5: the Set up pane's counts and its rows in every state, a long line wrapped whole. */
export default await setupPaneScene("states");
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane] [data-step-line]';
