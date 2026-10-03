import { accountsScene } from "../accounts-scene.js";
import { settingsGeometry } from "../settings-scene.js";
export default await accountsScene("accounts.default-model");
// look.md §12.2–12.3: described defaults in divided groups, with 32px pickers.
export const geometry = (viewport: Parameters<typeof settingsGeometry>[0]) => [...settingsGeometry(viewport),
  { selector: '[data-settings-pane] select:not([aria-label="Environment"])', height: 32, maxWidth: 320 },
];
export const readySelector = "[data-accounts-scene-ready]";
export const ladders = ["light", "dark"] as const;
