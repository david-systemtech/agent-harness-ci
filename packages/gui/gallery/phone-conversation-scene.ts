import type { SceneGeometry } from "./scene-registry.js";

/** Request content scrolls separately; the composer keeps its place below it. */
export const revealPhoneDecision = (selector: string) => () => {
  const reveal = () => {
    const decision = document.querySelector<HTMLElement>(selector);
    if (!decision) { document.querySelector<HTMLButtonElement>(".phone-prompt-summary button")?.click(); return; }
    observer.disconnect();
  };
  const observer = new MutationObserver(reveal);
  observer.observe(document.getElementById("root")!, { subtree: true, childList: true });
  reveal();
  return () => observer.disconnect();
};

export const conversationGeometry = (decision: string): readonly SceneGeometry[] => [
  { selector: "[data-web-client]", contentFits: true },
  { selector: '[aria-label="Transcript"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[data-web-client] :is(button, input, select, textarea)', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  { selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: decision, minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Stop"], [aria-label="Send"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-web-client]" },
];
