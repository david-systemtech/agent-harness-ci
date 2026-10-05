import type { SceneModule } from "./scene-registry.js";
import { script, route, arrangeWeb } from "./phone-frame-scene.js";

/** The actual browser grant, its compact disclosure and deliberate replacement flow. */
export const phoneLimitedAccessScene = (step: "strip" | "details" | "pair"): SceneModule => ({
  platform: "web", script, route, arrangeWeb,
  activate: () => {
    let detailsOpened = false, pairingOpened = false;
    const advance = () => {
      if (!document.querySelector('[aria-label="Message"]')) return;
      const details = [...document.querySelectorAll<HTMLButtonElement>('[data-limited-access] button')][0];
      if (step !== "strip" && details && !detailsOpened) { detailsOpened = true; details.click(); }
      const action = [...document.querySelectorAll<HTMLButtonElement>('[data-access-sheet] button')].find(button => button.textContent === "Give this phone full access");
      if (step === "pair" && action && !pairingOpened) { pairingOpened = true; action.click(); }
    };
    const observer = new MutationObserver(advance);
    observer.observe(document.body, { subtree: true, childList: true });
    advance();
    return () => observer.disconnect();
  },
  readySelector: step === "strip" ? '[data-limited-access]' : step === "details" ? '[data-access-sheet] ul' : '[data-access-sheet] [aria-label="Pair by link"]',
  geometry: ({ width }) => step === "strip" ? [
    { selector: '[data-limited-access]', maxWidth: width, height: 45, contentFits: true },
    { selector: '[data-limited-access] button', minimumWidth: 44, minimumHeight: 44 },
  ] : [
    { selector: '[data-access-sheet]', maxWidth: width - 32 },
    { selector: '[data-access-sheet] p, [data-access-sheet] li', contentFits: true },
    { selector: '[data-access-sheet] button', minimumHeight: 44 },
  ],
});
