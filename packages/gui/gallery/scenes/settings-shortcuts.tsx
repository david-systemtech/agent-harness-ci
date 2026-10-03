import { appearanceScene } from "../appearance-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";

export default appearanceScene("appearance.shortcuts", 'table[aria-label="Anywhere"]');
export const readySelector = '[data-appearance-ready="appearance.shortcuts"]';
/** look.md §15 and §5.1: shortcut tables, 20px keycaps and 24px record buttons. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: 'input[aria-label="Search the shortcuts"]', height: 32 },
  { selector: 'table[aria-label="Anywhere"] kbd', height: 20 },
  { selector: 'table[aria-label="Anywhere"] button', height: 24 },
];
