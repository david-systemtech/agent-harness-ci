export { platform, script, route, arrangeWeb } from "../phone-frame-scene.js";
import type { SceneViewport } from "../scene-registry.js";
import { safeAreas } from "../phone-frame-scene.js";
export const activate = safeAreas(true);
export const readySelector = '.phone-frame-drawer [data-sidebar-row]';
export const geometry = ({ width }: SceneViewport) => [
  { selector: '.phone-frame-drawer', width: width === 360 ? 344 : 360, paddingTop: 20, paddingLeft: 8 },
  { selector: '.phone-frame-drawer button', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  { selector: '.phone-frame-drawer input', minimumHeight: 44, visibleWithin: '.phone-frame-drawer' },
  { selector: '.phone-frame-drawer [data-sidebar-row]', minimumWidth: 44, minimumHeight: 44 },
  { selector: '.phone-frame-drawer [data-sidebar-details]', contentFits: true },
  { selector: '.phone-frame-drawer [aria-label="Close sessions"]', visibleWithin: '.phone-frame-drawer' },
];
