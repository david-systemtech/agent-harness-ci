export { platform, script, route, arrangeWeb } from "../phone-frame-scene.js";
import { headerGeometry, safeAreas } from "../phone-frame-scene.js";
export const activate = safeAreas();
export const readySelector = '[aria-label="Message"]';
export const geometry = [
  ...headerGeometry,
  { selector: "[data-window-header]", minimumTop: 20, visibleWithin: "[data-web-client]" },
  { selector: "[data-limited-access]", below: "[data-window-header]", contentFits: true, visibleWithin: "[data-web-client]" },
  { selector: "[data-web-client] > main", below: "[data-limited-access]", visibleWithin: "[data-web-client]" },
  { selector: "[data-grid-card]", visibleWithin: "[data-web-client] main" },
  { selector: '[aria-label="Send"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: '[data-web-client]' },
  { selector: '[aria-label="Message"]', visibleWithin: '[data-web-client]' },
];
