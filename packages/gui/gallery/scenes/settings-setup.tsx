import { settingsScene, settingsGeometry } from "../settings-scene.js";
/** look.md §12 and §16: setup Settings state. */
export default await settingsScene(false, "setup.checklist", { environments: [{ name: "desk", reach: "local" }] });
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane]';
