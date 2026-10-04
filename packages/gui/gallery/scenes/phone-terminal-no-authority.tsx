import type { SceneModule } from "../scene-registry.js";
export { PhoneTerminalScene as default, phoneTerminalGeometry as geometry } from "../phone-terminal-scene.js";
export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{}] }] };
export const readySelector = '[aria-label="Terminal keys"]';
