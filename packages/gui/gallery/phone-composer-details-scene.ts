import type { SceneModule } from "./scene-registry.js";
import { arrangeWeb as arrangeBrowser } from "./scenes/phone-browser.js";
import { platform, script, route, arrangeWeb } from "./phone-compact-composer-scene.js";

/** Exercise each toolbar entry with the actual phone dialog/menu focus owners. */
export const composerDetailsScene = (label: string, browser = false): SceneModule => ({
  platform, script, route,
  arrangeWeb: world => { arrangeWeb(world); if (browser) arrangeBrowser(world); },
  activate: () => {
    let stopped = false;
    const show = () => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-phone-composer-toolbar] button")).find(candidate => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
      if (!button || button.disabled) return;
      observer.disconnect();
      button.click();
      if (!browser) void (async () => {
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (stopped) return;
        const sheet = document.querySelector<HTMLElement>(".phone-composer-sheet")!;
        await Promise.all(sheet.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        if (stopped) return;
        const bottom = parseFloat(getComputedStyle(sheet).bottom);
        const actual = sheet.getBoundingClientRect().bottom;
        if (Math.abs(actual - (innerHeight - bottom)) > 1) throw new Error(`Composer details end at ${actual}px; expected ${innerHeight - bottom}px (translate ${getComputedStyle(sheet).translate}, transform ${getComputedStyle(sheet).transform})`);
        sheet.setAttribute("data-composer-details-proof", "passed");
      })().catch(error => {
        if (stopped) return;
        document.querySelector(".phone-composer-sheet")?.setAttribute("data-composer-details-proof", "failed");
        queueMicrotask(() => { throw error; });
      });
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    show();
    return () => { stopped = true; observer.disconnect(); };
  },
  readySelector: browser ? '[role="dialog"]:has([data-web-browser])' : '[data-composer-details-proof]',
  geometry: [
    { selector: browser ? '[role="dialog"]:has([data-web-browser])' : '.phone-composer-sheet', visibleWithin: browser ? '[role="dialog"]:has([data-web-browser])' : '.phone-composer-sheet', contentFits: true },
    { selector: browser ? '[role="dialog"]:has([data-web-browser]) button' : '.phone-composer-sheet button', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  ],
});
