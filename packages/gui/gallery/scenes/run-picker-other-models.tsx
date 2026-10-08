import type { SceneGeometry } from "../scene-registry.js";
import { RunPickerScene } from "./run-picker.js";

export { arrange, script } from "./run-picker.js";

/** The run picker with Other models open beside the Models column (#1821), as the right arrow opens it. */
export default RunPickerScene;

/** Opens the flyout from its row once the picker is drawn, as a keyboard does. */
export const activate = () => {
  const open = () => {
    const trigger = document.querySelector<HTMLElement>("[data-other-models]");
    if (trigger === null || trigger.getAttribute("data-state") === "open") return trigger !== null;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    return true;
  };
  if (open()) return;
  const observer = new MutationObserver(() => { if (open()) observer.disconnect(); });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
};

export const readySelector = "[data-other-models-list]";

/** The flyout keeps the picker's 288px menu width and 320px cap, every row inside it. */
export const geometry: readonly SceneGeometry[] = [
  { selector: '[data-run-column="Models"]', width: 256 },
  { selector: "[data-other-models-list]", width: 288, maxHeight: 320 },
  { selector: '[data-other-models-list] [role="menuitem"]', renderedOnly: true, contentFits: true },
];
