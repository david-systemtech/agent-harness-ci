import { accountsScene } from "../accounts-scene.js";
import { settingsGeometry } from "../settings-scene.js";
export default await accountsScene("accounts.default-model", "Model family");
export const geometry = (viewport: Parameters<typeof settingsGeometry>[0]) => [...settingsGeometry(viewport),
  { selector: "[data-default-picker]", width: viewport.width < 1200 ? 512 : 736, visibleWithin: '[aria-label="New-session defaults"]' },
  { selector: '[data-default-picker] [data-run-column="Models"]', width: viewport.width < 1200 ? 512 : 256 },
];
export const readySelector = "[data-accounts-scene-ready]";
export const ladders = ["light", "dark"] as const;
