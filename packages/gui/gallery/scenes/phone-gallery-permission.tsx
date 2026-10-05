import type { SceneModule } from "../scene-registry.js";
export { platform, script, route } from "./phone-gallery-conversation.js";

export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk");
  env.startRun(env.sessionId(), "Check the receipt totals.");
  env.openPrompt(env.sessionId(), { kind: "permission", summary: "Run the receipt-checking command", toolName: "Bash", input: { command: "printf receipts" } });
};
export const readySelector = '[aria-label="Allow once"][data-permission-revealed]';
export { revealPermissionDecision as activate } from "../phone-first-slice.js";
export const geometry = [
  { selector: '[data-web-client] :is(button, input, select, textarea)', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  { selector: '[aria-label="Stop"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Deny"]', minimumWidth: 44, minimumHeight: 44 },
  { selector: '[aria-label="Transcript"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Allow once"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-composer-above]" },
];
