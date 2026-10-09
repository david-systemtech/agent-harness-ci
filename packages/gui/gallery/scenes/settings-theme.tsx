import { appearanceScene } from "../appearance-scene.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";

const scene = appearanceScene("appearance.theme", '[aria-label="Dark colours"]');
export const { script, presentation, readySelector } = scene;
/** Show the detailed colour preview, including after another scene closes its fold. */
export const activate = () => {
  scene.activate();
  const expand = () => {
    const more = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-pane] button")].find((button) => button.textContent?.includes("More options"));
    if (more === undefined) return;
    observer.disconnect();
    if (more.getAttribute("aria-expanded") !== "true") more.click();
  };
  const observer = new MutationObserver(expand);
  observer.observe(document.body, { childList: true, subtree: true });
  expand();
  return () => observer.disconnect();
};
/** look.md §12.1, §12.3 and §5.1: bounded Settings, stepper and seed swatches. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: 'input[type="number"]', height: 32 },
  { selector: 'button[aria-label="Decrease text size"]', width: 24, height: 24 },
  { selector: 'button[aria-label="Increase text size"]', width: 24, height: 24 },
  { selector: '[role="img"][title]', width: 24, height: 24 },
  { selector: '[data-settings-pane] button[role="switch"]', width: 32, height: 18.4 },
];
