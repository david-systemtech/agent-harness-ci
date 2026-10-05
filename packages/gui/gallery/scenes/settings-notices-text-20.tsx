import { settingsNoticesScene, settingsNoticesGeometry } from "../settings-notices-scene.js";
export const readySelector = "[data-settings-notices] li:nth-child(5)";
export default await settingsNoticesScene(true, 20);
export const geometry = settingsNoticesGeometry(20);
