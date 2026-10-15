import type { SceneGeometry, SceneViewport } from "./scene-registry.js";
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

/** How a scene's Sessions list sits in the phone: rows under each heading, top to bottom (a folded shelf
 * has none), and the pixels its scroller never gets at text size 14 (safe areas, the bar or the drawer's
 * caption, a pinned footer, plus a margin for borders and paddings this estimate leaves out). */
export interface SessionListShape {
  readonly sections: readonly number[];
  readonly chrome: number;
  /** The Sessions page scrolls as one, footer after the rows; the drawer pins its footer under them. */
  readonly footerScrolls: boolean;
}

/** The phone scenes' list (phone-frame-scene's script): Receipt checks, desk and Snoozed hold a row each;
 * Settled and Archive stay folded. */
const SCENE_SECTIONS = [1, 1, 1, 0, 0];

/** The Sessions page: 20 + 16 safe areas, the 52px bar, the body's 4px padding, and a 64px margin. */
export const SESSIONS_PAGE: SessionListShape = { sections: SCENE_SECTIONS, chrome: 20 + 16 + 52 + 8 + 64, footerScrolls: true };
/** The drawer: 20 + 16 safe areas, its 44px caption, its pinned 3-line footer (3 × 44 + gaps + border), and a 32px margin. */
export const SESSIONS_DRAWER: SessionListShape = { sections: SCENE_SECTIONS, chrome: 20 + 16 + 44 + 137 + 32, footerScrolls: false };

/** The Sessions list under `scope` (the page or the drawer): every control is painted at 44px, and what a
 * user can tap without scrolling keeps an uncovered 44px hit area: the controls above the list, the
 * drawer's pinned footer, and every heading and row that fits the viewport at the scene's text size. Rows
 * past the fold are off screen by design, so they are not hit-tested; the estimate errs short (a row is
 * 54px times the font scale, a heading 44px) so a counted row is genuinely on screen. */
export const sessionListHitAreas = (scope: string, { height, fontScale = 1 }: SceneViewport, shape: SessionListShape): SceneGeometry[] => {
  const pinned = shape.footerScrolls ? ":not([data-sidebar-scroll]):not([data-sidebar-footer])" : ":not([data-sidebar-scroll])";
  const reach: SceneGeometry[] = [{ selector: `${scope} nav > ${pinned} button`, renderedOnly: true, hitArea: 44 }];
  // Above the list: New session (8 + 44 + 8) and the filter line (8 + 44 + 6).
  let left = height - shape.chrome - 60 - 58;
  const row = 54 * Math.max(1, fontScale);
  shape.sections.every((rows, index) => {
    const heading = (index === 0 ? 0 : 12) + 44;
    if (left < heading) return false;
    left -= heading;
    const section = `${scope} [data-sidebar-scroll] > section:nth-of-type(${index + 1})`;
    reach.push({ selector: `${section} > :not(ul) button`, renderedOnly: true, hitArea: 44 });
    const fitting = Math.min(rows, Math.max(0, Math.floor((left - 2) / row)));
    if (fitting > 0) {
      left -= 2 + fitting * row;
      reach.push({ selector: `${section} > ul > li:nth-child(-n+${fitting}) button`, renderedOnly: true, hitArea: 44 });
    }
    return fitting === rows;
  });
  // The page's footer follows the last section: its three lines count only when they fit too.
  if (shape.footerScrolls && reach.length === 1 + shape.sections.length + shape.sections.filter(rows => rows > 0).length && left >= 12 + 3 * 46) {
    reach.push({ selector: `${scope} [data-sidebar-footer] button`, renderedOnly: true, hitArea: 44 });
  }
  return [{ selector: `${scope} button`, renderedOnly: true, minimumWidth: 44, minimumHeight: 44 }, ...reach];
};
