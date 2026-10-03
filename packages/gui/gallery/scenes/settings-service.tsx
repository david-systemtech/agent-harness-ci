import { settingsScene, settingsGeometry } from "../settings-scene.js";

export default await settingsScene(false, "environments.service", { environments: [
  { name: "desk", reach: "local", icon: "desktop", colour: "teal", status: { activity: { state: "busy", reason: "run-running" } } },
] }, "Drain…");
export const readySelector = 'body:has([data-service-confirmation]) [data-settings-pane] input[title]';
/** look.md §5.1, §12.2–12.3: state actions and labelled session fields. */
export const geometry: typeof settingsGeometry = (viewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-service-confirmation]", width: 384, paddingLeft: 16, paddingTop: 16 },
  { selector: '[data-settings-pane] button[data-variant][data-size="default"]', height: 32 },
  { selector: '[data-settings-pane] input[title]', height: 32 },
  { selector: '[data-service-confirmation] button[data-variant][data-size="default"]', height: 32 },
];
export const ladders = ["light", "dark"] as const;
