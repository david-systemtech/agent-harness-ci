import { script } from "./window-empty.js";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";
export { script };
/** look.md §3, §9.1 and §16: text scales; the desktop frame and stored sidebar width stay fixed. */
export const presentation: Partial<PresentationValues> = { textSize: 20 };
export const geometry: readonly SceneGeometry[] = [
  { selector: "html", fontSize: 16 * 20 / 14 },
  { selector: "[data-window-header]", height: 44 },
  { selector: "[data-sidebar-card]", width: 224 },
  { selector: 'nav[aria-label="Sessions"] button[aria-label="New session"]', visibleWithin: '[data-sidebar-card]' },
  { selector: 'nav[aria-label="Sessions"] button[aria-label="New session"] span span', visibleWithin: '[data-sidebar-card]', contentFits: true, fontSize: 0.8 * 16 * 20 / 14 },
  { selector: 'nav[aria-label="Sessions"] kbd', visibleWithin: '[data-sidebar-card]', contentFits: true, fontSize: 11 * 20 / 14 },
  { selector: 'nav[aria-label="Sessions"] > div:last-of-type button span', visibleWithin: '[data-sidebar-card]', contentFits: true, fontSize: 11 * 20 / 14 },
];
