import type { SceneViewport } from "../scene-registry.js";
import { phoneFirstScene } from "../phone-first-slice.js";
export default await phoneFirstScene("permission", 360, 740, 20);
export const readySelector = '[aria-label="Allow once"][data-permission-revealed]';
export const geometry = ({ width }: SceneViewport) => [
  { selector: "[data-web-client]", width: 360 },
  { selector: '[aria-label="Allow once"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Deny"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  ...(width < 640 ? [] : [
    { selector: '[aria-label="Permission request"]', minimumHeight: 48, contentFits: true },
    { selector: '[aria-label="Permission decision"]', below: '[aria-label="Permission request"]' },
  ]),
];
