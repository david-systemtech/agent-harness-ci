import { routinesScene } from "../routines-scene.js";
import { settingsGeometry } from "../settings-scene.js";
export default await routinesScene(true);
/** look.md §12.1–12.3: settings bounds and 12px routine card padding. */
export const geometry = (viewport: { readonly width: number; readonly height: number }) => [
  ...settingsGeometry(viewport),
  { selector: "[data-routine-card]", paddingLeft: 12, paddingTop: 12 },
  { selector: "[data-routine-card] button", height: 28 },
];
export const readySelector = "[data-routine-card]";
export const ladders = ["light", "dark"] as const;
