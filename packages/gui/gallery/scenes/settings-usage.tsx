import { accountsScene } from "../accounts-scene.js";
import { settingsGeometry } from "../settings-scene.js";
export default await accountsScene("accounts.usage");
// look.md §10.5 and §12.3: one identity across environments, 24px rings and 4px bars; one unknown limit listed, two counted (#1893).
export const geometry = (viewport: Parameters<typeof settingsGeometry>[0]) => [...settingsGeometry(viewport),
  { selector: '[data-settings-pane] svg[role="img"]', width: 24, height: 24 },
  { selector: '[aria-label="Windows"] span[aria-hidden="true"]', height: 4 },
];
export const readySelector = "[data-accounts-scene-ready]";
export const ladders = ["light", "dark"] as const;
