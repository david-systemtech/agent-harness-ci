import { routinesScene } from "../routines-scene.js";
export default await routinesScene(false);
/** look.md §7: compact scheduled strip and 12px calendar glyphs. */
export const geometry = [
  { selector: "[data-scheduled-strip] svg", width: 12, height: 12 },
  { selector: "[data-scheduled-strip] button", fontSize: 11 },
] as const;
export const readySelector = "[data-scheduled-strip]";
export const ladders = ["light", "dark"] as const;
