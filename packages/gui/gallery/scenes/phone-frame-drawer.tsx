export { platform, script, route, arrangeWeb } from "../phone-frame-scene.js";
import { safeAreas } from "../phone-frame-scene.js";
export const activate = safeAreas(true);
export const readySelector = '.phone-frame-drawer [data-sidebar-row]';
export const geometry = [
  { selector: '.phone-frame-drawer', maxWidth: 374, paddingTop: 20, paddingLeft: 8 },
  { selector: '.phone-frame-drawer button', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  { selector: '.phone-frame-drawer input', minimumHeight: 44, visibleWithin: '.phone-frame-drawer' },
  { selector: '.phone-frame-drawer [data-sidebar-row]', minimumWidth: 44, minimumHeight: 44 },
  { selector: '.phone-frame-drawer [aria-label="Close sessions"]', visibleWithin: '.phone-frame-drawer' },
];
