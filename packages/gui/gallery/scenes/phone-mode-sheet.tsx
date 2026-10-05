import type { SceneModule } from "../scene-registry.js";
export { platform, script, route, arrangeWeb } from "../phone-frame-scene.js";
export const readySelector = "[data-mode-sheet]";

/** The actual Mode chip and sheet; no account/model/effort projection. */
export const activate = () => {
  let expanded = false, opened = false;
  const show = () => {
    if (!expanded) {
      const toggle = document.querySelector<HTMLButtonElement>("[data-phone-status-toggle]");
      if (!toggle) return;
      expanded = true; toggle.click(); return;
    }
    if (!document.querySelector('[data-phone-status="open"]')) return;
    if (!opened) {
      const chip = document.querySelector<HTMLButtonElement>('[aria-label^="Mode:"]');
      if (!chip?.hasAttribute("data-state") || chip.getAttribute("aria-disabled") === "true") return;
      opened = true; chip.click();
    }
  };
  const observer = new MutationObserver(show);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  show();
  return () => observer.disconnect();
};
export const geometry: SceneModule["geometry"] = ({ width, height }) => [
  { selector: "[data-mode-sheet]", width: width - 16, maxHeight: height - 32 },
  { selector: '.mode-sheet-choice', minimumHeight: 44, minimumWidth: 44, contentFits: true },
  { selector: '[aria-label="Close mode picker"]', minimumHeight: 44, minimumWidth: 44, visibleWithin: '[data-mode-sheet]' },
];
