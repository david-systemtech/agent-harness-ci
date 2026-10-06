export { platform, script, arrangeWeb } from "../phone-frame-scene.js";
import { headerGeometry, safeAreas } from "../phone-frame-scene.js";
export const activate = safeAreas();
export const readySelector = "[data-welcome]";
export const geometry = [
  ...headerGeometry,
  { selector: "[data-welcome] button", minimumWidth: 44, minimumHeight: 44 },
];
