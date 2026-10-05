import type { SceneModule } from "./scene-registry.js";
import { platform, script, route, arrangeWeb } from "./phone-compact-composer-scene.js";

/** Exercise each toolbar entry with the actual phone dialog/menu focus owners. */
export const composerDetailsScene = (label: string, browser = false): SceneModule => ({
  platform, script, route, arrangeWeb,
  activate: () => {
    const show = () => {
      const button = document.querySelector<HTMLButtonElement>(`[data-phone-composer-toolbar] [aria-label${browser ? "^" : ""}="${label}"]`);
      if (!button || button.disabled) return;
      observer.disconnect();
      button.click();
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    show();
    return () => observer.disconnect();
  },
  readySelector: browser ? '[data-run-sheet][role="dialog"]' : '[role="dialog"].phone-composer-sheet',
  geometry: [
    { selector: browser ? '[data-run-sheet]' : '.phone-composer-sheet', visibleWithin: browser ? '[data-run-sheet]' : '.phone-composer-sheet', contentFits: true },
    { selector: browser ? '[data-run-sheet] [role="menuitem"]' : '.phone-composer-sheet button', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  ],
});
