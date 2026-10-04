import { phoneFirstScene } from "../phone-first-slice.js";
export default await phoneFirstScene("pairing", 390, 844);
export const geometry = [
  { selector: "[data-web-client]", width: 390 },
  { selector: "[data-web-client] button", minimumHeight: 44 },
  { selector: "[data-web-client] input", fontSize: 16 * 16 / 14, minimumHeight: 44 },
];
