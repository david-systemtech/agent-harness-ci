import { settingsScene, settingsGeometry } from "../settings-scene.js";

export default await settingsScene(false, "environments.machines", { environments: [
  { name: "desk", reach: "local", icon: "desktop", colour: "teal" },
  { name: "laptop", reach: "paired", icon: "laptop", colour: "amber", settings: { "updates.autoUpdate": false } },
] }, "Make a pairing code");
export const readySelector = '[aria-label="QR code of the pairing link"]';
/** look.md §5.1, §12.2–12.3: card inset, sixteen-pixel badge, shared controls. */
export const geometry: typeof settingsGeometry = (viewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-settings-card-grid] + section", maxWidth: 768, contentFits: true },
  { selector: "[data-machine-card]", width: viewport.width >= 1280 ? 541 : 720, contentFits: true },
  { selector: "[data-machine-card]", paddingLeft: 12, paddingTop: 12 },
  { selector: "[data-machine-card] > header > svg", width: 16, height: 16 },
  { selector: '[data-machine-card] button[data-variant][data-size="default"]', height: 32 },
  { selector: '[aria-label="Copy pairing link"]', height: 24 },
  { selector: '[data-machine-card] input[title="Name (type; Enter to rename)"]', height: 32 },
];
export const ladders = ["light", "dark"] as const;
