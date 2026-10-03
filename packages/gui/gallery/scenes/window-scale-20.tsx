import { script } from "./window-empty.js";
import type { PresentationValues } from "../../src/presentation.js";
export { script };
/** look.md §3 and §16: rem chrome scales while the stored sidebar width stays fixed. */
export const presentation: Partial<PresentationValues> = { textSize: 20 };
export const geometry = [
  { selector: "html", fontSize: 20 },
  { selector: '[data-measure="header"]', height: 62.857142857142854 },
  { selector: '[data-sidebar-card]', width: 224 },
];
