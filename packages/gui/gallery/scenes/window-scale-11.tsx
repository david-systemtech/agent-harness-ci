import { script } from "./window-empty.js";
import type { PresentationValues } from "../../src/presentation.js";
export { script };
/** look.md §3 and §16: rem chrome scales while the stored sidebar width stays fixed. */
export const presentation: Partial<PresentationValues> = { textSize: 11 };
export const geometry = [
  { selector: "html", fontSize: 16 * 11 / 14 },
  { selector: 'header', height: 34.57142857142857 },
  { selector: '[data-sidebar-card]', width: 224 },
];
