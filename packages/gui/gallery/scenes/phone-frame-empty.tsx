export { platform, script, arrangeWeb } from "../phone-frame-scene.js";
import type { SceneGeometry, SceneViewport } from "../scene-registry.js";
import { sessionListHitAreas, stackGeometry, stackSafeAreas } from "../phone-stack-scene.js";

/** No session open: the phone starts on the Sessions page, the stack's root, with no back. */
export const activate = stackSafeAreas();
export const readySelector = '[data-phone-page="sessions"] [data-sidebar-row]';
export const geometry = (viewport: SceneViewport): readonly SceneGeometry[] => [
  ...stackGeometry,
  { selector: '[data-phone-page="sessions"]', below: "[data-window-header]", visibleWithin: "[data-web-client]" },
  ...sessionListHitAreas('[data-phone-page="sessions"]', viewport),
  { selector: '[data-phone-page="sessions"] [data-sidebar-row]', minimumHeight: 44 },
  { selector: '[data-phone-page="sessions"] input', minimumHeight: 44 },
];
