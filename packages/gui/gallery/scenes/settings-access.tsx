import { settingsScene, settingsGeometry } from "../settings-scene.js";

export default await settingsScene(false, "environments.access", { environments: [
  { name: "desk", reach: "local", icon: "desktop", colour: "teal", clientSessions: [
    { label: "Chrome on Android (Home Screen)", kind: "web", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" },
    { label: "Travel window", kind: "desktop", ceiling: "acceptEdits" },
    { label: "Build helper", kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "plan" },
  ] },
] }, "Revoke…");
export const readySelector = "[data-revoke-confirmation]";
/** look.md §5.1, §12.2–12.3: divided groups and thirty-two-pixel controls. */
export const geometry: typeof settingsGeometry = (viewport) => [
  ...settingsGeometry(viewport),
  { selector: '[data-settings-pane] [role="group"][aria-labelledby]', maxWidth: 768, contentFits: true },
  { selector: "[data-revoke-confirmation]", width: 384, paddingLeft: 16, paddingTop: 16 },
  { selector: 'ul[aria-label="Client sessions"] > li', paddingLeft: 12, paddingTop: 12 },
  { selector: 'ul[aria-label="Programs"] > li', paddingLeft: 12, paddingTop: 12 },
  { selector: '[data-settings-pane] select', height: 32 },
  { selector: '[data-settings-pane] button[data-variant][data-size="default"]', height: 32 },
];
export const ladders = ["light", "dark"] as const;
