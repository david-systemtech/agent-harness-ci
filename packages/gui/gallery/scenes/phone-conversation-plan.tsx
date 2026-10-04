import type { SceneModule } from "../scene-registry.js";
import { conversationGeometry, revealPhoneDecision } from "../phone-conversation-scene.js";
export { platform, script, route } from "./phone-gallery-conversation.js";

export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk"), sessionId = env.sessionId();
  env.startRun(sessionId, "Plan the receipt checks.");
  env.openPrompt(sessionId, { kind: "plan", summary: "Check the receipts", mode: "plan", ceiling: "acceptEdits", plan: "## Check the receipts\n\n" + Array.from({ length: 24 }, (_, at) => `${at + 1}. Compare the amount with the summary and explain any difference.\n`).join("\n") });
};
export const readySelector = '[aria-label="Approve · continue in acceptEdits"]';
export const activate = revealPhoneDecision(readySelector);
export const geometry = conversationGeometry(readySelector);
