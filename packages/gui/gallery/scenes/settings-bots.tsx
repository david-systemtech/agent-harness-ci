import { settingsScene, settingsGeometry } from "../settings-scene.js";
/** look.md §12 and §16: the registered Bots pane retains its availability message. */
export default await settingsScene(false, "routines.bots");
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane]';
