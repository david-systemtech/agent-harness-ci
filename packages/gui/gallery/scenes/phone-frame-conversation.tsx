export { platform, script, route, arrangeWeb } from "../phone-frame-scene.js";
import { headerGeometry, safeAreas } from "../phone-frame-scene.js";
export const activate = safeAreas();
export const readySelector = '[aria-label="Message"]';
export const geometry = [
  ...headerGeometry,
  { selector: '[aria-label="Send"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: '[data-web-client]' },
  { selector: '[aria-label="Message"]', visibleWithin: '[data-web-client]' },
];
