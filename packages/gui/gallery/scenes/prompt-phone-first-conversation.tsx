import { phoneFirstScene } from "../phone-first-slice.js";
export default await phoneFirstScene("conversation", 390, 844);
export const readySelector = '[aria-label="Message"]';
export const geometry = [
  { selector: "[data-web-client]", width: 390 },
  { selector: '[aria-label="Send"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Message"]', fontSize: 16 * 16 / 14, visibleWithin: "[data-web-client]" },
];
