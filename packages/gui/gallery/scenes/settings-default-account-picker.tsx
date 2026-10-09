import { accountsScene } from "../accounts-scene.js";
import { settingsGeometry } from "../settings-scene.js";

export default await accountsScene("accounts.default-model", "Default account");
export const geometry = (viewport: Parameters<typeof settingsGeometry>[0]) => [...settingsGeometry(viewport),
  { selector: "[data-default-picker]", width: viewport.width < 1200 ? 512 : 736, visibleWithin: '[aria-label="New-session defaults"]' },
  { selector: '[data-default-picker] [data-run-column="Accounts"]', width: viewport.width < 1200 ? 512 : 224 },
  { selector: '[data-default-picker] [data-run-column="Accounts"] [data-run-identity]', unbroken: true },
];
export const readySelector = "[data-accounts-scene-ready]";
export const ladders = ["light", "dark"] as const;
