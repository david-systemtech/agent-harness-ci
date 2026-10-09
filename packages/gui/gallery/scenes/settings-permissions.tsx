import { accessSettingsScene } from "../access-settings-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";

export default await accessSettingsScene("access.permissions");
export const readySelector = "[data-access-scene-ready]";
export const ladders = ["light", "dark"] as const;
/** look.md §12.1–12.3: dialog/nav/body, described choices, the timeout and Test (setup-copy.md §5.12). */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-settings-pane]", paddingLeft: 24, paddingTop: 20 },
  { selector: "[data-settings-pane] [role=radiogroup] label", paddingLeft: 10, paddingTop: 8 },
  { selector: "[data-settings-pane] [role=radiogroup] label span.font-medium", fontSize: 12 },
  { selector: "[data-settings-pane] [role=radiogroup] label span.text-2xs", fontSize: 11 },
  { selector: "[data-settings-pane] input:not([type=radio]), [data-settings-pane] select", height: 32 },
  { selector: '[data-settings-pane] form[aria-label="Test the always-ask list"] button', height: 32 },
];
