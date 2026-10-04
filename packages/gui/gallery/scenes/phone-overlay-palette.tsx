export { script, presentation } from "./phone-overlay-workspace.js";
export const platform = "web";
export const activate = () => {
  let opened = false;
  const show = () => {
    const box = document.querySelector<HTMLTextAreaElement>('[data-new-session] textarea');
    if (opened || !box) return;
    opened = true; box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  };
  const observer = new MutationObserver(show);
  observer.observe(document.body, { childList: true, subtree: true });
  show();
  return () => observer.disconnect();
};
export const readySelector = '[data-measure="palette"]';
export const geometry = [
  { selector: '[data-measure="palette"]', visibleWithin: '[data-palette-overlay]' },
  { selector: '[data-measure="palette"] [cmdk-input]', minimumHeight: 44 },
  { selector: '[data-measure="palette"] [cmdk-item]', minimumHeight: 44 },
  { selector: '[aria-label="Close command palette"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: '[data-palette-overlay]' },
];
