import type { ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { verifyKeyboardDock, verifyReadableReplyLines } from "../phone-keyboard-dock-geometry.js";
import { safeAreas } from "../phone-frame-scene.js";
export { platform, script, route } from "../phone-frame-scene.js";

export const filledKeyboardPrompt = { promptId: "keyboard-permission", kind: "permission" as const, summary: "Read receipts", toolName: "Bash", input: { command: "printf receipts\n".repeat(24) } };

let world: ScriptedWorld;
export const arrangeWeb = (value: ScriptedWorld) => {
  world = value;
  const env = world.environment("desk");
  const { runId } = env.startRun(env.sessionId(), "Keep the latest receipt line visible while composing.");
  env.emit(env.sessionId(), "assistant.text", { runId, itemId: "history", text: "A readable receipt line.\n\n".repeat(24), aborted: false });
  env.endRun(env.sessionId(), runId);
};
export const readySelector = "[data-keyboard-proof]";
export const geometry = [
  { selector: '[aria-label="Transcript"]', minimumHeight: 84, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Stop"]', minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-web-client]" },
];

export const activate = () => {
  const actual = window.visualViewport;
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  // Dispatch on the subscribed viewport; its owner reads the current bounds on that one path.
  const fit = (type = "resize") => (actual ?? window).dispatchEvent(new Event(type));
  const stopInsets = safeAreas()();
  let stopped = false, started = false;
  const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const run = async () => {
    await document.fonts.ready;
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    field.focus(); fit(); await settle();
    // All captures for this scene use the 390x844 profile; no whole-window keyboard resize.
    if (innerWidth !== 390 || innerHeight !== 844) throw new Error("Keyboard proof requires layout viewport 390x844");
    verifyKeyboardDock(844, 0);
    viewport.height = 480; fit(); await settle(); verifyKeyboardDock(480, 0);
    viewport.offsetTop = 120; fit("scroll"); await settle(); verifyKeyboardDock(480, 120);
    const env = world.environment("desk");
    const { runId } = env.startRun(env.sessionId(), "Stream another receipt line");
    env.emit(env.sessionId(), "assistant.delta", { runId, itemId: "keyboard-stream", fragments: [{ kind: "text", text: "The latest receipt line stays visible. " }] });
    await settle(); verifyKeyboardDock(480, 120);
    const transcript = document.querySelector<HTMLElement>('[aria-label="Transcript"]')!;
    transcript.scrollTop -= 160; transcript.dispatchEvent(new Event("scroll"));
    await settle();
    const reading = transcript.scrollTop;
    env.emit(env.sessionId(), "assistant.delta", { runId, itemId: "keyboard-stream", fragments: [{ kind: "text", text: "Another line arrives while reading. ".repeat(12) }] });
    await settle();
    if (Math.abs(transcript.scrollTop - reading) > 1) throw new Error("Streaming moved the reader");
    const jump = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Jump to the latest"));
    if (!jump) throw new Error("Keyboard proof missing Jump to latest");
    jump.click(); await settle(); verifyKeyboardDock(480, 120);
    // A settled paragraph exercises the markdown line height as well as the streaming text.
    env.emit(env.sessionId(), "assistant.text", { runId, itemId: "keyboard-stream", text: "The latest receipt line stays visible. " + "Another line arrives while reading. ".repeat(12), aborted: false });
    await settle(); verifyKeyboardDock(480, 120);
    env.notice("environment.updated", { fromVersion: "0.5.0", toVersion: "0.5.1" });
    await settle(); verifyKeyboardDock(480, 120);
    document.querySelector<HTMLButtonElement>('[aria-label="Notifications"] [aria-label="Dismiss"]')!.click();
    await settle();
    env.openPrompt(env.sessionId(), filledKeyboardPrompt);
    await settle(); verifyKeyboardDock(480, 120);
    const details = document.querySelector<HTMLButtonElement>(".phone-prompt-summary button");
    if (!details) throw new Error("Keyboard proof missing waiting summary");
    verifyReadableReplyLines();
    const summary = details.getBoundingClientRect();
    if (summary.top < 120 || summary.bottom > 600) throw new Error("Keyboard clips request Details");
    details.click(); await settle();
    const allow = document.querySelector<HTMLButtonElement>('[aria-label="Allow once"]');
    const sheet = document.querySelector<HTMLElement>(".phone-prompt-sheet");
    if (!allow || !sheet) throw new Error("Keyboard proof missing request sheet");
    const action = allow.getBoundingClientRect(), well = sheet.getBoundingClientRect();
    if (action.top < well.top || action.bottom > well.bottom + 1) throw new Error("Keyboard clips the waiting-card action");
    allow.click(); await settle();
    field.focus({ preventScroll: true });
    // Browser bars resize, then keyboard close. Focus and draft must survive both.
    viewport.height = 450; fit(); await settle(); verifyKeyboardDock(450, 120);
    viewport.height = 844; viewport.offsetTop = 0; fit(); await settle(); verifyKeyboardDock(844, 0);
    if (document.activeElement !== field) throw new Error("Keyboard close lost focus");
    viewport.height = 480; viewport.offsetTop = 120; fit(); await settle(); verifyKeyboardDock(480, 120);
    if (!stopped) document.querySelector("[data-web-client]")!.setAttribute("data-keyboard-proof", "passed");
  };
  const start = () => {
    started = true;
    observer.disconnect();
    void run().catch(error => {
      if (stopped) return;
      // Let capture reach its page-error gate instead of hiding a failed assertion
      // behind a readiness timeout. A failed proof still aborts the capture.
      document.querySelector("[data-web-client]")!.setAttribute("data-keyboard-proof", "failed");
      queueMicrotask(() => { throw error; });
    });
  };
  const observer = new MutationObserver(() => {
    if (!started && document.querySelector('[aria-label="Message"]')) start();
  });
  observer.observe(document.body, { subtree: true, childList: true });
  if (document.querySelector('[aria-label="Message"]')) start();
  return () => {
    stopped = true; observer.disconnect(); stopInsets();
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete (window as { visualViewport?: unknown }).visualViewport;
  };
};
