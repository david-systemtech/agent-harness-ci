import type { SceneModule } from "../scene-registry.js";
import { conversationGeometry } from "../phone-conversation-scene.js";
export { platform, script, route } from "./phone-gallery-conversation.js";
export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk"), session = env.sessionId();
  const { runId } = env.startRun(session, "Check the receipt totals.");
  env.emit(session, "assistant.thinking", { runId, itemId: "thought", text: "Compare each amount.", aborted: false });
  env.emit(session, "assistant.text", { runId, itemId: "reply", text: "The receipt totals agree.", aborted: false });
  env.emit(session, "tool.started", { runId, toolCallId: "timed-read", name: "Read", input: { file_path: "totals.txt" }, title: null, agentId: null, parentToolCallId: null });
  env.emit(session, "tool.ended", { runId, toolCallId: "timed-read", status: "error", output: "Try the other receipt file.", durationMs: 20 });
  env.endRun(session, runId);
};
export const readySelector = '[data-tool-call="timed-read"] time';
export const geometry = [
  ...conversationGeometry('[aria-label="Send"]'),
  { selector: '[aria-label="Transcript"] time', unbroken: true, contentFits: true },
];
