import { accessSettingsScene } from "../access-settings-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";

export default await accessSettingsScene("access.browser");
export const readySelector = "[data-access-scene-ready]";
/** look.md §12.1–12.3: dialog/body, 32px fields and 32×18.4 switch. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-settings-pane]", paddingLeft: 24, paddingTop: 20 },
  { selector: '[data-settings-pane] input[aria-label="Pairing code"], [data-settings-pane] select', height: 32 },
  { selector: '[data-settings-pane] textarea', minimumHeight: 128 },
  { selector: '[data-settings-pane] [role=switch]', width: 32, height: 18.4 },
];
