import type { SceneGeometry } from "../scene-registry.js";
import { arrangeUsage, openChip } from "../new-session-picker-scene.js";

export { presentation, script } from "../new-session-picker-scene.js";

/** The new-session surface's model chip open (#1894): accounts with their rings, the recommended models with the pin hint, Other models, the efforts. */
export const arrange = arrangeUsage;
export const activate = openChip("Models", false);
export const readySelector = '[data-run-column="Accounts"] [data-usage-rings] [role="img"]';

/** look.md §10.6, as the status line's picker: 224/256/256 columns, independently capped lists, one 16px ring line per account. */
export const geometry: readonly SceneGeometry[] = [
  { selector: '[data-run-column="Accounts"]', width: 224 },
  { selector: '[data-run-column="Models"]', width: 256 },
  { selector: '[data-run-column="Effort"]', width: 256 },
  { selector: '[data-run-column="Accounts"] [data-run-list]', maxHeight: 320 },
  { selector: '[data-run-column="Models"] [data-run-list]', maxHeight: 320 },
  { selector: '[data-run-column="Accounts"] [data-usage-rings]', height: 16 },
  // An account's name is one line, cut with an ellipsis, even beside the selected row's check mark (#1963).
  { selector: '[data-run-column="Accounts"] [data-run-primary]', unbroken: true },
];
