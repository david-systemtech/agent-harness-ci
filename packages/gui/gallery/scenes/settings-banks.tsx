import { bankScene } from "../bank-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";
export default await bankScene(false);
export const readySelector = "[data-bank-scene-ready]";
/** look.md §12.1–12.3: bounded Settings, bank cards and compact facts. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-bank-content]", width: Math.min(viewport.width >= 1280 ? 1440 : 1000, viewport.width - 48) - 256 },
  { selector: "[data-bank-card]", width: viewport.width >= 1280 ? 541 : 720, contentFits: true },
  { selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 },
  { selector: "[data-bank-card] button[data-size='default']", height: 32 },
];
