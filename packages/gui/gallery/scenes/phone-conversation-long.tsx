import type { SceneModule } from "../scene-registry.js";
import { conversationGeometry } from "../phone-conversation-scene.js";
export { platform, script, route } from "./phone-gallery-conversation.js";

export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk"), sessionId = env.sessionId();
  const { runId } = env.startRun(sessionId, "Check the receipts and the unusually-long-receipt-filename-for-the-quarter.txt attachment.", [{ kind: "file", name: "unusually-long-receipt-filename-for-the-quarter.txt", mediaType: "text/plain", data: "cmVjZWlwdHM=" }]);
  env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "## Receipt checks\n\n" + Array.from({ length: 12 }, (_, at) => `${at + 1}. Compare the amount and explain the rounding rule.\n`).join("\n"), aborted: false });
  env.emit(sessionId, "tool.started", { runId, toolCallId: "checks", name: "Bash", title: "Check receipt totals", input: { command: "printf receipts" }, agentId: null, parentToolCallId: null });
  env.emit(sessionId, "tool.ended", { runId, toolCallId: "checks", status: "ok", output: "All receipt totals match.\n".repeat(12), durationMs: 20 });
  env.endRun(sessionId, runId);
  env.emit(sessionId, "session.draft-set", { draft: "Explain the receipt totals in the summary." }, { fields: { draft: "Explain the receipt totals in the summary." } });
};
export const readySelector = '[aria-label="Message"]';
export const geometry = conversationGeometry('[aria-label="Send"]');
