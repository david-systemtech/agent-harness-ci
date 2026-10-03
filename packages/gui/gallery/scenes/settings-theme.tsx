import { appearanceScene } from "../appearance-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";

export const { script, presentation, activate, readySelector } = appearanceScene("appearance.theme", '[aria-label="Dark ladder"]');
/** look.md §12.1, §12.3 and §5.1: bounded Settings, stepper and seed swatches. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: 'input[type="number"]', height: 32 },
  { selector: 'button[aria-label="Decrease text size"]', width: 24, height: 24 },
  { selector: 'button[aria-label="Increase text size"]', width: 24, height: 24 },
  { selector: '[role="img"][title]', width: 24, height: 24 },
  { selector: '[data-settings-pane] button[role="switch"]', width: 32, height: 18.4 },
];
