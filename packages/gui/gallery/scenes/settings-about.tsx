import { appearanceScene } from "../appearance-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";

export default appearanceScene("about.about", '[data-managed-tool="bao"]');
export const readySelector = '[data-appearance-ready="about.about"]';
/** look.md §12.3 and §5.3: version facts, divided tools and item padding. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-managed-tool]", paddingLeft: 12, paddingTop: 10 },
  { selector: '[data-managed-tool] header > svg', width: 16, height: 16 },
];
