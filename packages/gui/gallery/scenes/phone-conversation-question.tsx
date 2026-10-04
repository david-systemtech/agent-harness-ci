import type { SceneModule } from "../scene-registry.js";
import { conversationGeometry, revealPhoneDecision } from "../phone-conversation-scene.js";
export { platform, script, route } from "./phone-conversation-long.js";

export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk"), sessionId = env.sessionId();
  env.startRun(sessionId, "Check the receipts and ask which checks to run.");
  env.openPrompt(sessionId, { kind: "question", summary: "Which checks should run?", questions: [{ header: "Checks", question: "Which checks should run before finishing the receipt summary?", multiSelect: false, options: [{ label: "Named tests", description: "Run only the tests covering the receipt totals and the rounding rule." }, { label: "Types", description: "Check the workspace types before continuing." }] }] });
};
export const readySelector = '[aria-label="Send answer"]';
export const activate = revealPhoneDecision(readySelector);
export const geometry = conversationGeometry(readySelector);
