import { arrangeUsage, openChip, pairedScript } from "../new-session-picker-scene.js";

export { presentation } from "../new-session-picker-scene.js";
export const script = pairedScript;

/** The new-session surface's model chip open on a phone (#1894): the recommended models with the pin hint and Other models, one column at a time. */
export const platform = "web";
export const arrangeWeb = arrangeUsage;
export const activate = openChip("Models", true);
export const readySelector = '[data-run-sheet] [data-run-column="Models"]:not([hidden])';
export const geometry = ({ width }: { readonly width: number }) => [
  { selector: "[data-run-sheet]", width: width - 16, visibleWithin: "[data-run-sheet]" },
  { selector: '[data-run-sheet] [role="menuitem"]', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, contentFits: true },
  { selector: "[data-run-sheet] button", renderedOnly: true, minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-run-sheet]" },
];
