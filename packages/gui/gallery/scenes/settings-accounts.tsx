import { accountsScene } from "../accounts-scene.js";
import { settingsGeometry } from "../settings-scene.js";
export default await accountsScene("accounts.accounts");
// look.md §12.3: compact account cards, swatches and the shared usage rings.
export const geometry = (viewport: Parameters<typeof settingsGeometry>[0]) => [...settingsGeometry(viewport),
  { selector: "[data-account-card]", width: viewport.width >= 1280 ? 541 : 720, contentFits: true },
  { selector: "[data-account-card]", paddingLeft: 12, paddingTop: 12 },
  { selector: "[data-account-card] svg[role=img]", width: 24, height: 24 },
  { selector: "[data-account-card] h3 > span[aria-hidden]", width: 8, height: 8 },
];
export const readySelector = "[data-accounts-scene-ready]";
export const ladders = ["light", "dark"] as const;
