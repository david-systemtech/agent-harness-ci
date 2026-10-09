import { arrangeUsage, openChip, pairedScript } from "../new-session-picker-scene.js";

export { presentation } from "../new-session-picker-scene.js";
export const script = pairedScript;

/** The new-session surface's account chip open on a phone (#1894): each account with its usage rings, one column at a time. */
export const platform = "web";
export const arrangeWeb = arrangeUsage;
export const activate = openChip("Accounts", true);
export const readySelector = '[data-run-sheet] [data-run-column="Accounts"]:not([hidden]) [data-usage-rings] [role="img"]';
export const geometry = ({ width }: { readonly width: number }) => [
  { selector: "[data-run-sheet]", width: width - 16, visibleWithin: "[data-run-sheet]" },
  { selector: '[data-run-sheet] [role="menuitem"]', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, contentFits: true },
  { selector: "[data-run-sheet] button", renderedOnly: true, minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-run-sheet]" },
  // The ring line scales with the text size, so here it is checked to fit the sheet, not for its 16px. Only rings that draw
  // something: the signed-out Spare draws none, and its row sits below the fold when the text is large or the keyboard is up.
  { selector: '[data-run-sheet] [data-usage-rings]:has([role="img"])', renderedOnly: true, visibleWithin: "[data-run-sheet]" },
  // An email is one line of its own, never broken mid-word (#1895).
  { selector: "[data-run-sheet] [data-run-identity]", renderedOnly: true, unbroken: true },
  // So is an account's name, the selected one's long email included (#1963).
  { selector: "[data-run-sheet] [data-run-primary]", renderedOnly: true, unbroken: true },
];
