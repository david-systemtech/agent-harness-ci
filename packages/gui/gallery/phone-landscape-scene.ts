import { routineFixture } from "./routine-fixtures.js";
import type { SceneModule } from "./scene-registry.js";
import { platform, script, route, arrangeWeb } from "./phone-compact-composer-scene.js";
import { filledKeyboardPrompt } from "./scenes/phone-keyboard-dock.js";
import { landscapeGeometry, verifyLandscape, verifyLandscapeOverlay } from "./phone-landscape-geometry.js";

type Surface = "conversation" | "keyboard" | "drawer" | "details";
export const landscapeScene = (surface: Surface): SceneModule => ({
  platform, script, route,
  arrangeWeb: world => {
    arrangeWeb(world);
    if (surface === "drawer") world.environment("desk").wire.answer("routines.list", () => ({ result: { routines: Array.from({ length: 4 }, (_, index) => routineFixture(`Receipt check ${index + 1}`, index + 1)) } }));
    if (surface === "keyboard") {
      const env = world.environment("desk");
      const { runId } = env.startRun(env.sessionId(), "Continue checking the receipts.");
      env.emit(env.sessionId(), "assistant.text", { runId, itemId: "landscape-reply", text: "The latest receipt line remains readable while composing. ".repeat(16), aborted: false });
      env.openPrompt(env.sessionId(), filledKeyboardPrompt);
    }
  },
  readySelector: "[data-landscape-proof]",
  geometry: [{ selector: '[data-landscape-proof="passed"]' }, ...(surface === "conversation" || surface === "keyboard" ? landscapeGeometry : [
    { selector: surface === "drawer" ? ".phone-frame-drawer" : ".phone-composer-sheet", ...(surface === "drawer" && { contentFits: true }) },
    ...(surface === "drawer" ? [
      { selector: ".phone-frame-drawer [data-sidebar-scroll]", minimumHeight: 54 },
      { selector: ".phone-frame-drawer [data-sidebar-row]", minimumHeight: 44, visibleWithin: ".phone-frame-drawer [data-sidebar-scroll]", hitTestable: true },
    ] : []),
    { selector: surface === "drawer" ? '[aria-label="Close sessions"]' : '.phone-composer-sheet [aria-label="Close dialog"]', minimumWidth: 44, minimumHeight: 44, hitTestable: true },
  ])],
  activate: () => {
    const root = document.documentElement;
    const insets = innerWidth === 844 ? { top: 0, right: 44, bottom: 21, left: 44 } : { top: 0, right: 0, bottom: 0, left: 0 };
    for (const [edge, value] of Object.entries(insets)) root.style.setProperty(`--phone-frame-safe-${edge}`, `${value}px`);
    const actual = window.visualViewport;
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const fit = () => (actual ?? window).dispatchEvent(new Event("resize"));
    const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    let stopped = false, started = false;
    const run = async () => {
      await document.fonts.ready;
      const frame = document.querySelector<HTMLElement>("[data-web-client]")!;
      if (!frame.hasAttribute("data-phone-frame")) throw new Error("Landscape restored the desktop projection");
      document.querySelector<HTMLButtonElement>('[aria-label="Dismiss limited access"]')?.click();
      await settle();
      const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
      fit(); await settle();
      if (surface === "keyboard") {
        field.focus({ preventScroll: true });
        // Keep layout media unchanged. The supported filled-dock rectangle includes
        // the waiting notice, three reply lines, 44px actions and the notch reserve.
        viewport.height = 330; viewport.offsetTop = 8; fit(); await settle();
        const column = document.querySelector<HTMLElement>("[data-composer-column]")!;
        column.scrollTop = 0;
        const above = document.querySelector<HTMLElement>("[data-composer-above]")!;
        const details = Array.from(above.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Details");
        if (!details) throw new Error("Landscape request is missing Details");
        above.scrollTop += Math.max(0, details.getBoundingClientRect().bottom - above.getBoundingClientRect().bottom);
        await settle();
        const trigger = details.getBoundingClientRect(), well = above.getBoundingClientRect();
        if (trigger.height < 44 || trigger.top < well.top - 1 || trigger.bottom > well.bottom + 1) throw new Error("Landscape request clips Details");
        details.click(); await settle();
        const sheet = document.querySelector<HTMLElement>(".phone-prompt-sheet")!;
        await Promise.all(sheet.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        verifyLandscapeOverlay(".phone-prompt-sheet", viewport.height, viewport.offsetTop);
        const body = sheet.querySelector<HTMLElement>("[data-phone-prompt-body]")!;
        const answers = sheet.querySelector<HTMLElement>("[data-phone-prompt-answer]")!;
        if (body.clientHeight < 44 || body.scrollHeight <= body.clientHeight) throw new Error("Landscape long request lacks a readable scrolling body");
        const before = answers.getBoundingClientRect();
        body.scrollTop = body.scrollHeight; await settle();
        const after = answers.getBoundingClientRect(), bounds = sheet.getBoundingClientRect();
        if (Math.abs(before.top - after.top) > 1) throw new Error("Landscape request scrolling moved its decisions");
        for (const button of sheet.querySelectorAll<HTMLButtonElement>("header button, [data-phone-prompt-answer] button")) {
          const action = button.getBoundingClientRect();
          const hit = document.elementFromPoint(action.left + action.width / 2, action.top + action.height / 2);
          if (action.height < 44 || action.width < 44 || action.top < bounds.top || action.bottom > bounds.bottom || action.left < bounds.left || action.right > bounds.right || !button.contains(hit)) throw new Error("Landscape long request clips its decision");
        }
        sheet.querySelector<HTMLButtonElement>("header button")!.click(); await settle();
        await Promise.all(sheet.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        field.focus({ preventScroll: true });
        // Close the full request before proving the latest reply and Message/Stop.
        column.scrollTop = column.scrollHeight;
        await settle();
      }
      if (surface === "drawer" || surface === "details") {
        // Overlay captures also use visual-only keyboard sizing, without changing media queries.
        viewport.height = 300; viewport.offsetTop = 8; fit(); await settle();
        const trigger = surface === "drawer" ? frame.querySelector<HTMLButtonElement>('[aria-label="Show sessions"]') : frame.querySelector<HTMLButtonElement>('[aria-label="Run settings"]');
        trigger!.click(); await settle();
        const selector = surface === "drawer" ? ".phone-frame-drawer" : ".phone-composer-sheet";
        const overlay = document.querySelector<HTMLElement>(selector)!;
        await Promise.all(overlay.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        if (surface === "drawer") {
          const results = overlay.querySelector<HTMLElement>("[data-sidebar-scroll]")!;
          // Routines share this bounded well with results, never fixed chrome.
          // Prove all four touch controls before scrolling to the session row.
          for (let attempt = 0; attempt < 60 && results.querySelectorAll("[data-scheduled-strip] button").length !== 4; attempt++) await settle();
          const routines = results.querySelectorAll<HTMLButtonElement>("[data-scheduled-strip] button");
          if (routines.length !== 4) throw new Error("Landscape drawer is missing its four scheduled routines");
          for (const button of routines) {
            results.scrollTop += Math.max(0, button.getBoundingClientRect().bottom - results.getBoundingClientRect().bottom);
            await settle();
            const action = button.getBoundingClientRect(), well = results.getBoundingClientRect();
            const hit = document.elementFromPoint(action.left + action.width / 2, action.top + action.height / 2);
            if (action.height < 44 || action.top < well.top - 1 || action.bottom > well.bottom + 1 || !button.contains(hit)) throw new Error("Landscape drawer clips a scheduled action");
          }
          results.scrollTop = results.scrollHeight;
          const footer = overlay.querySelector<HTMLElement>("[data-sidebar-footer]")!;
          // Both footer actions stay reachable in their own well; the result row
          // keeps its hit area, rather than yielding all space to fixed chrome.
          for (const button of footer.querySelectorAll<HTMLButtonElement>("button")) {
            footer.scrollTop += Math.max(0, button.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom);
            await settle();
            const action = button.getBoundingClientRect(), well = footer.getBoundingClientRect();
            if (action.top < well.top - 1 || action.bottom > well.bottom + 1) throw new Error("Landscape drawer clips a footer action");
          }
          await settle();
        }
        verifyLandscapeOverlay(selector, viewport.height, viewport.offsetTop);
      } else verifyLandscape(viewport.height, viewport.offsetTop, surface === "keyboard");
      if (!stopped) frame.setAttribute("data-landscape-proof", "passed");
    };
    const start = () => {
      if (started || !document.querySelector('[aria-label="Workspace: receipts"]')) return;
      started = true; observer.disconnect();
      void run().catch(error => {
        if (stopped) return;
        const frame = document.querySelector("[data-web-client]");
        frame?.setAttribute("data-landscape-proof", "failed");
        // Preserve a complete report/capture set on a proof failure. The mandatory
        // passed selector above still blocks geometry; the capture shows the reason.
        const diagnostic = document.createElement("output");
        diagnostic.className = "absolute inset-x-0 top-0 z-50 bg-float p-2 text-xs text-ink";
        diagnostic.textContent = error instanceof Error ? error.message : String(error);
        frame?.append(diagnostic);
      });
    };
    const observer = new MutationObserver(start);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    start();
    return () => {
      stopped = true; observer.disconnect();
      for (const edge of Object.keys(insets)) root.style.removeProperty(`--phone-frame-safe-${edge}`);
      if (original) Object.defineProperty(window, "visualViewport", original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    };
  },
});
