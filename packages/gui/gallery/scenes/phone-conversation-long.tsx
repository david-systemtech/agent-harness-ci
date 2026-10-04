import type { SceneModule } from "../scene-registry.js";
import { conversationGeometry } from "../phone-conversation-scene.js";
export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", capabilities: ["workspaceChecks"], scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, provider: { fileInput: true }, accounts: [{ id: "account-1", label: "Scripted account" }], sessions: Array.from({ length: 1 }, () => ({ title: "Check the receipts", model: "scripted-model" })) }] };
export const route: NonNullable<SceneModule["route"]> = world => ({ session: { environmentId: world.environment("desk").environmentId, sessionId: world.environment("desk").sessionId() } });

export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk"), sessionId = env.sessionId();
  const { runId } = env.startRun(sessionId, "Check the receipts and the unusually-long-receipt-filename-for-the-quarter.txt attachment.", [{ kind: "file", name: "unusually-long-receipt-filename-for-the-quarter.txt", mediaType: "text/plain", data: "cmVjZWlwdHM=" }]);
  env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "## Receipt checks\n\n" + Array.from({ length: 12 }, (_, at) => `${at + 1}. Compare the amount and explain the rounding rule.\n`).join("\n"), aborted: false });
  env.emit(sessionId, "tool.started", { runId, toolCallId: "checks", name: "Bash", title: "Check receipt totals", input: { command: "printf receipts" }, agentId: null, parentToolCallId: null });
  env.emit(sessionId, "tool.ended", { runId, toolCallId: "checks", status: "ok", output: "All receipt totals match.\n".repeat(12), durationMs: 20 });
  env.emit(sessionId, "message.sent", { runId, messageId: "00000000-0000-4000-8000-000000000154", text: "Explain the rounding rule after checking the receipts.", attachments: [], delivery: "queued", heldBy: "environment", ceiling: "acceptEdits" });
  env.emit(sessionId, "session.draft-set", { draft: "Explain the receipt totals in the summary." }, { fields: { draft: "Explain the receipt totals in the summary." } });
};
export const readySelector = '[data-attachment-chip]';
export const activate = () => {
  let attached = false;
  const prepare = () => {
    const folded = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Transcript"] button[aria-expanded="false"]')].find(button => button.textContent?.includes("Ran a command"));
    folded?.click();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Files to attach"]');
    const call = document.querySelector<HTMLButtonElement>('[data-tool-call="checks"] button');
    if (!input || !call) return;
    if (!attached) {
      attached = true;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["Receipt totals"], "unusually-long-receipt-filename-for-the-quarter.txt", { type: "text/plain" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      call.click();
    }
    const result = [...document.querySelectorAll<HTMLButtonElement>('[data-tool-call="checks"] button[aria-expanded="false"]')].find(button => button.textContent === "Result");
    result?.click();
    if (document.querySelector("[data-attachment-chip]") && call.getAttribute("aria-expanded") === "true") {
      call.scrollIntoView({ block: "start" });
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(prepare);
  observer.observe(document.getElementById("root")!, { subtree: true, childList: true, attributes: true });
  prepare();
  return () => observer.disconnect();
};
export const geometry = conversationGeometry('[aria-label="Send"]');
