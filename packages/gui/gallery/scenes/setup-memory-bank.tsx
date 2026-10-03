import { bankScene } from "../bank-scene.js";
export default await bankScene(true);
export const readySelector = "[data-bank-scene-ready]";
/** look.md §12.2 and §13.2: fixed rail, bounded choices and visible footer. */
export const geometry = [
  { selector: 'nav[aria-label="Set up steps"]', width: 280 },
  { selector: 'nav[aria-label="Set up steps"] button > span:first-child', width: 18 },
  { selector: "[data-bank-content]", maxWidth: 620 },
  { selector: "[data-bank-choices]", paddingLeft: 6, paddingTop: 6 },
  { selector: "[data-bank-form]", paddingLeft: 16, paddingTop: 16 },
  { selector: "[data-bank-form] [data-bank-field]", maxWidth: 224 },
  { selector: "[data-bank-form] input", height: 32 },
  { selector: 'footer[aria-label="Step navigation"]', height: 67 },
  { selector: 'footer[aria-label="Step navigation"] button', height: 32 },
];
