import { settingsScene, settingsGeometry } from "../settings-scene.js";
/** look.md §12 and §16: read-only Settings state. */
export default await settingsScene(false, "access.forges", { environments: [{ name: "desk", reach: "local", scopes: ["read"] }] });
export const geometry = settingsGeometry;
export const readySelector = '[data-settings-pane]';
