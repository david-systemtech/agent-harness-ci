import type { SceneGeometry } from "./scene-registry.js";
import { safeAreas } from "./phone-frame-scene.js";

/** The phone bar on every stack page (audit §3.7): 52 high under the safe area, the sessions drawer
 * control first at the top left, 44 px targets, and the title fitting its line. */
export const stackGeometry: readonly SceneGeometry[] = [
  { selector: "[data-web-client]", paddingTop: 20, paddingLeft: 8 },
  { selector: "[data-window-header]", minimumHeight: 52, minimumTop: 20, visibleWithin: "[data-web-client]" },
  { selector: "[data-window-header] button", hitArea: 44, visibleWithin: "[data-web-client]" },
  { selector: '[data-window-header] > button:first-child[aria-label="Show sessions"]', hitArea: 44 },
  { selector: "[data-phone-title]", contentFits: true, visibleWithin: "[data-window-header]" },
];

/** Safe-area fixtures; `drawer` opens the sessions drawer once the Sessions page has rows. */
export const stackSafeAreas = ({ drawer = false } = {}) => () => {
  const reset = safeAreas()();
  const tryOpen = () => {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Show sessions"]');
    if (!trigger || !document.querySelector('[data-phone-page="sessions"] [data-sidebar-row]')) return;
    observer.disconnect(); trigger.click();
  };
  const observer = new MutationObserver(tryOpen);
  if (drawer) { observer.observe(document.body, { subtree: true, childList: true }); tryOpen(); }
  return () => { observer.disconnect(); reset(); };
};
