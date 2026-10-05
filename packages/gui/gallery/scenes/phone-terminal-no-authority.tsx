import type { SceneModule } from "../scene-registry.js";
import { phoneTerminalGeometry } from "../phone-terminal-scene.js";
export { PhoneTerminalScene as default } from "../phone-terminal-scene.js";
export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{}] }] };
export const readySelector = '[data-access-unavailable]';
export const geometry: SceneModule['geometry'] = [
  ...phoneTerminalGeometry.filter(check => !check.selector.includes('Terminal keys')),
  { selector: '[data-access-unavailable] button', minimumHeight: 44, visibleWithin: '[aria-label="Terminal sheet"]' },
];
