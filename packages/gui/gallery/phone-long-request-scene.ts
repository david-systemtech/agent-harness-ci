import type { SceneModule } from "./scene-registry.js";
import { platform, script, route, safeAreas } from "./phone-frame-scene.js";

/** Visual-only keyboard bounds, full requests, and pinned decisions without ancestor scrolling. */
export function longRequestScene(kind: "permission" | "question" | "plan"): SceneModule {
  return {
    platform, script, route,
    arrangeWeb: world => {
      const env = world.environment("desk"), sessionId = env.sessionId();
      const { runId } = env.startRun(sessionId, "Review receipts before continuing.");
      env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "Read each receipt and preserve the rounding rule.\n\n".repeat(30), aborted: false });
      env.openPrompt(sessionId, { kind, summary: "Review all receipt totals before continuing", reason: "The command reads the full receipt list without changing it. ".repeat(24), toolName: "Bash", ceiling: "acceptEdits", mode: "plan", input: { command: "printf receipts\n".repeat(80) }, plan: "## Receipt checks\n\n" + "1. Compare every amount with the summary and explain any difference.\n\n".repeat(40), questions: [{ header: "Checks", question: "Which checks should run before finishing?", multiSelect: true, options: Array.from({ length: 12 }, (_, at) => ({ label: `Receipt group ${at + 1}`, description: "Compare the receipts with the summary and keep the original rounding rule." })) }] });
    },
    readySelector: "[data-long-request-proof]",
    activate: () => {
      const actual = window.visualViewport;
      const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
      const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: Math.min(480, innerHeight), offsetTop: innerHeight > 600 ? 120 : 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      const stopInsets = safeAreas()();
      let stopped = false;
      const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const run = async () => {
        await document.fonts.ready;
        document.documentElement.style.setProperty("--font-scale", String(20 / 14));
        const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
        field.focus({ preventScroll: true });
        (actual ?? window).dispatchEvent(new Event("resize")); await settle();
        const transcript = document.querySelector<HTMLElement>('[aria-label="Transcript"]')!.getBoundingClientRect();
        if (transcript.height < 84) throw new Error("Long request collapsed the transcript");
        const details = document.querySelector<HTMLButtonElement>(".phone-prompt-summary button")!;
        const button = details.getBoundingClientRect();
        if (button.height < 44 || button.bottom > viewport.height + viewport.offsetTop) throw new Error("Long request clipped Details");
        const page = [scrollX, scrollY];
        details.click(); await settle();
        const sheet = document.querySelector<HTMLElement>(".phone-prompt-sheet")!;
        const body = sheet.querySelector<HTMLElement>("[data-phone-prompt-body]")!;
        const strip = sheet.querySelector<HTMLElement>("[data-phone-prompt-answer]")!;
        const before = strip.getBoundingClientRect();
        if (body.clientHeight < 44 || body.scrollHeight <= body.clientHeight) throw new Error("Long request lacks a readable scrolling body");
        body.scrollTop = body.scrollHeight; await settle();
        const after = strip.getBoundingClientRect();
        if (Math.abs(before.top - after.top) > 1 || after.bottom > viewport.height + viewport.offsetTop) throw new Error("Request scrolling moved the answer strip");
        if (scrollX !== page[0] || scrollY !== page[1]) throw new Error("Request details scrolled the page");
        if (!stopped) sheet.setAttribute("data-long-request-proof", "passed");
      };
      const start = () => {
        if (!document.querySelector(".phone-prompt-summary button")) return;
        observer.disconnect();
        void run().catch(error => {
          if (stopped) return;
          document.querySelector("[data-web-client]")?.setAttribute("data-long-request-proof", "failed");
          queueMicrotask(() => { throw error; });
        });
      };
      const observer = new MutationObserver(start);
      observer.observe(document.body, { subtree: true, childList: true }); start();
      return () => { stopped = true; observer.disconnect(); stopInsets(); if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as { visualViewport?: unknown }).visualViewport; };
    },
    geometry: [
      { selector: ".phone-prompt-sheet", visibleWithin: "[data-web-client]", contentFits: true },
      { selector: "[data-phone-prompt-body]", minimumHeight: 44 },
      { selector: "[data-phone-prompt-answer]", visibleWithin: ".phone-prompt-sheet" },
      { selector: "[data-phone-prompt-answer] button, .phone-prompt-sheet header button", minimumWidth: 44, minimumHeight: 44, visibleWithin: ".phone-prompt-sheet", hitTestable: true },
      { selector: '[aria-label="Transcript"]', minimumHeight: 84, visibleWithin: "[data-web-client]" },
      { selector: '[aria-label="Message"], [aria-label="Stop"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
    ],
  };
}
