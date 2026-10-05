import type { ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneModule } from "../scene-registry.js";
import { conversationGeometry } from "../phone-conversation-scene.js";
export { platform, route } from "./phone-gallery-conversation.js";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", capabilities: ["workspaceChecks"], scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: Array.from({ length: 1 }, () => ({ title: "Check the receipts" })) }] };

let world: ScriptedWorld;
export const arrangeWeb: SceneModule["arrangeWeb"] = value => {
  world = value;
  const env = world.environment("desk"), session = env.sessionId();
  const { runId } = env.startRun(session, "Read and copy the receipt report.");
  env.emit(session, "assistant.text", { runId, itemId: "reading-history", text: "## Receipt report\n\nSelect any reply text with the browser's normal copy menu. Read history while new receipts arrive.\n\n```text\nreceipt_total = 42; rounding_rule = keep_original; report_label = quarterly_receipt_comparison\n```", aborted: false });
  for (const id of ["reading-open", "reading-closed"]) {
    env.emit(session, "tool.started", { runId, toolCallId: id, name: "Read", title: null, input: { file_path: `${id}.txt` }, agentId: null, parentToolCallId: null });
    env.emit(session, "tool.ended", { runId, toolCallId: id, status: "ok", output: "Receipt totals agree.\n".repeat(3), durationMs: 20 });
  }
  env.emit(session, "assistant.text", { runId, itemId: "reading-long-reply", text: "More receipt history.\n\n".repeat(24), aborted: false });
  env.endRun(session, runId);
};
export const readySelector = '[data-reading-proof="passed"]';
export const geometry = conversationGeometry('[aria-label="Stop"]');

export const activate = () => {
  let stopped = false;
  const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const run = async () => {
    await document.fonts.ready;
    const transcript = document.querySelector<HTMLElement>('[aria-label="Transcript"]')!;
    const dock = document.querySelector<HTMLElement>("[data-composer-column]")!;
    const bottom = dock.getBoundingClientRect().bottom;
    const stable = () => {
      if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) throw new Error("Transcript reading moved the page");
      if (Math.abs(dock.getBoundingClientRect().bottom - bottom) > 1) throw new Error("Transcript reading moved the dock");
    };
    const controls = getComputedStyle(transcript);
    if (controls.overscrollBehavior !== "none" || getComputedStyle(document.documentElement).overscrollBehavior !== "none") throw new Error("Transcript boundary suppression missing");
    if (controls.userSelect !== "text" || controls.touchAction !== "auto") throw new Error("Native selection or pinch zoom disabled");
    for (const boundary of [0, transcript.scrollHeight]) {
      transcript.scrollTop = boundary; transcript.dispatchEvent(new Event("scroll")); await settle(); stable();
    }
    const group = Array.from(transcript.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Read 2 files"));
    if (!group) throw new Error("Reading proof missing tool group");
    group.click(); await settle();
    const card = transcript.querySelector<HTMLElement>('[data-tool-call="reading-open"]')!;
    const toggle = card.querySelector<HTMLButtonElement>("button")!;
    toggle.click(); await settle();
    const input = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Input")!;
    input.click(); await settle();
    const result = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Result")!;
    result.click(); await settle();
    const code = transcript.querySelector<HTMLElement>("pre code")!;
    transcript.scrollTop += code.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 12;
    transcript.dispatchEvent(new Event("scroll")); await settle();
    const reading = transcript.scrollTop;
    const jump = document.querySelector<HTMLElement>("[data-transcript-jump]");
    if (!jump) throw new Error("Reading proof missing Jump to latest");
    const background = getComputedStyle(jump).backgroundColor;
    if ((background.startsWith("rgba") || background.includes("/")) && Number(background.match(/[\d.]+\s*\)$/)?.[0].replace(")", "")) < 1) throw new Error("Jump to latest lets transcript text show through");
    const text = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 13);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange")); await settle();
    const selected = selection.toString();
    const env = world.environment("desk"), session = env.sessionId();
    const { runId } = env.startRun(session, "Stream more receipts while reading.");
    env.emit(session, "assistant.delta", { runId, itemId: "reading-stream", fragments: [{ kind: "text", text: "A new receipt arrives. ".repeat(8) }] });
    await settle(); stable();
    if (Math.abs(transcript.scrollTop - reading) > 1 || selection.toString() !== selected || selection.anchorNode !== text) throw new Error("Streaming moved history or replaced selected text");
    toggle.click(); await settle(); stable(); toggle.click(); await settle(); stable();
    const retained = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Result");
    if (retained?.getAttribute("aria-expanded") !== "true") throw new Error("Reading lost tool fold state");
    // Native horizontal code scrolling is independent of the page/dock.
    code.parentElement!.scrollLeft = 100; await settle(); stable();
    if (code.parentElement!.scrollWidth > code.parentElement!.clientWidth && code.parentElement!.scrollLeft === 0) throw new Error("Code cannot scroll horizontally");
    code.parentElement!.scrollLeft = 0;
    if (!stopped) document.querySelector("[data-web-client]")!.setAttribute("data-reading-proof", "passed");
  };
  const observer = new MutationObserver(() => {
    if (!document.querySelector('[aria-label="Message"]') || !document.querySelector("pre code")) return;
    observer.disconnect();
    void run().catch(error => {
      if (stopped) return;
      document.querySelector("[data-web-client]")!.setAttribute("data-reading-proof", "failed");
      queueMicrotask(() => { throw error; });
    });
  });
  observer.observe(document.body, { subtree: true, childList: true });
  return () => { stopped = true; observer.disconnect(); document.getSelection()?.removeAllRanges(); };
};
