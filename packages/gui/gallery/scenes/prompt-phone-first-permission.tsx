import { phoneFirstScene } from "../phone-first-slice.js";
export default await phoneFirstScene("permission", 360, 740, 20);
export const readySelector = '[aria-label="Allow once"][data-permission-revealed]';
export const geometry = [
  { selector: "[data-web-client]", width: 360 },
  { selector: '[aria-label="Allow once"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Deny"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
];
