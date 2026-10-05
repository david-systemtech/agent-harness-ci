import type { SceneModule } from "./scene-registry.js";
import { arrangeWeb as arrangeBrowser } from "./scenes/phone-browser.js";
import { platform, script, route, arrangeWeb } from "./phone-compact-composer-scene.js";

/** Exercise each toolbar entry with the actual phone dialog/menu focus owners. */
export const composerDetailsScene = (label: string, browser = false): SceneModule => ({
  platform, script, route,
  arrangeWeb: world => { arrangeWeb(world); if (browser) arrangeBrowser(world); },
  activate: () => {
    const show = () => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-phone-composer-toolbar] button")).find(candidate => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
      if (!button || button.disabled) return;
      observer.disconnect();
      button.click();
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    show();
    return () => observer.disconnect();
  },
  readySelector: browser ? '[role="dialog"]:has([data-web-browser])' : '[role="dialog"].phone-composer-sheet',
  geometry: [
    { selector: browser ? '[role="dialog"]:has([data-web-browser])' : '.phone-composer-sheet', visibleWithin: browser ? '[role="dialog"]:has([data-web-browser])' : '.phone-composer-sheet', contentFits: true },
    { selector: browser ? '[role="dialog"]:has([data-web-browser]) button' : '.phone-composer-sheet button', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  ],
});
