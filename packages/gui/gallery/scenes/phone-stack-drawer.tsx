export { platform, script, arrangeWeb } from "../phone-frame-scene.js";
import type { SceneGeometry, SceneViewport } from "../scene-registry.js";
import { SESSIONS_DRAWER, sessionListHitAreas, stackGeometry, stackSafeAreas } from "../phone-stack-scene.js";

/** The sessions drawer opened from the stack's root page: quick switching stays one tap away everywhere. */
export const activate = stackSafeAreas({ drawer: true });
export const readySelector = '.phone-frame-drawer [data-sidebar-row]';
export const geometry = (viewport: SceneViewport): readonly SceneGeometry[] => [
  ...stackGeometry.filter(check => !check.selector.startsWith("[data-window-header]")),
  ...sessionListHitAreas(".phone-frame-drawer", viewport, SESSIONS_DRAWER),
  { selector: ".phone-frame-drawer [data-sidebar-row]", minimumHeight: 44 },
  { selector: '.phone-frame-drawer [aria-label="Close sessions"]', visibleWithin: ".phone-frame-drawer" },
];
