export { platform, script, route, arrangeWeb } from "../phone-frame-scene.js";
import type { SceneGeometry } from "../scene-registry.js";
import { safeAreas } from "../phone-frame-scene.js";
import { stackGeometry } from "../phone-stack-scene.js";

/** A handed session link opens two deep: Sessions beneath, the conversation on top, with back in the bar. */
export const activate = safeAreas();
export const readySelector = '[data-window-header][data-phone-depth="2"] [aria-label="Back"]';
export const geometry: readonly SceneGeometry[] = [
  ...stackGeometry,
  { selector: '[data-window-header] [aria-label="Back"]', hitArea: 44, visibleWithin: "[data-window-header]" },
  { selector: "[data-phone-subtitle]", visibleWithin: "[data-window-header]" },
  { selector: '[data-phone-page="session"]', below: "[data-window-header]", visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Message"]', visibleWithin: "[data-web-client]" },
];
