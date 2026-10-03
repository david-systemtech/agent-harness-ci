import { accountsScene } from "../accounts-scene.js";
import { settingsGeometry } from "../settings-scene.js";
export default await accountsScene("accounts.default-model");
// look.md §12.2–12.3: friendly names above mono ids, controls beside their descriptions.
export const geometry = (viewport: Parameters<typeof settingsGeometry>[0]) => [...settingsGeometry(viewport),
  { selector: '[data-settings-pane] [data-default-choice]', minimumHeight: 32, visibleWithin: "[data-settings-pane]" },
];
export const readySelector = "[data-accounts-scene-ready]";
export const ladders = ["light", "dark"] as const;
