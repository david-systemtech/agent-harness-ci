import { script } from "./window-empty.js";
import type { PresentationValues } from "../../src/presentation.js";
export { script };
/** look.md §3, §9.1 and §16: text scales; the desktop frame and stored sidebar width stay fixed. */
export const presentation: Partial<PresentationValues> = { textSize: 11 };
export const geometry = [
  { selector: "html", fontSize: 16 * 11 / 14 },
  { selector: "[data-window-header]", height: 44 },
  { selector: '[data-sidebar-card]', width: 224 },
];
