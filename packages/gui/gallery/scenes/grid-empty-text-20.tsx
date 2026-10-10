import type { PresentationValues } from "../../src/presentation.js";
import { PANE_CARD_UNSCROLLABLE } from "../geometry.js";
import type { SceneGeometry } from "../scene-registry.js";
export { script } from "./window-empty.js";

/** Both split directions at the supported maximum text size (#2064). */
export const presentation: Partial<PresentationValues> = { textSize: 20, paneLayout: { focused: "pane-3", rows: [
  { id: "row-1", height: 50, panes: [{ id: "pane-1", width: 50, session: null }, { id: "pane-2", width: 50, session: null }] },
  { id: "row-2", height: 50, panes: [{ id: "pane-3", width: 100, session: null }] },
] } };
export const readySelector = "[data-welcome-scroll-proof]";
export const geometry: readonly SceneGeometry[] = [
  PANE_CARD_UNSCROLLABLE,
  { selector: "html", fontSize: 16 * 20 / 14 },
  { selector: "[data-welcome]", visibleWithin: "[data-grid-card]" },
  { selector: "[data-welcome-tile]", width: 44, height: 44 },
];

export const activate = () => {
  let stopped = false, checking = false;
  const advance = () => {
    const welcomes = Array.from(document.querySelectorAll<HTMLElement>("[data-welcome]"));
    if (checking || welcomes.length !== 3 || welcomes.some(welcome => welcome.querySelectorAll("li").length !== 8)) return;
    checking = true;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (stopped) return;
      for (const welcome of welcomes) {
        // jsdom checks the rendered surface; hosted capture proves native scrolling and geometry.
        if (welcome.clientHeight === 0) continue;
        if (getComputedStyle(welcome).overflowY !== "auto") throw new Error("The empty welcome needs an ordinary scrollport.");
        const pane = welcome.closest("[data-grid-card]")!;
        const caption = pane.querySelector("[data-pane-caption]")!;
        const captionTop = caption.getBoundingClientRect().top;
        const bounds = welcome.getBoundingClientRect();
        welcome.scrollTop = 0;
        for (const element of welcome.querySelectorAll<HTMLElement>("[data-welcome-tile], h2, button, li")) {
          welcome.scrollTop += element.getBoundingClientRect().top - bounds.top - 2;
          const rect = element.getBoundingClientRect();
          if (rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5
            || rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5) {
            throw new Error("Welcome controls and every legend row must be reachable inside their own pane.");
          }
        }
        if (caption.getBoundingClientRect().top !== captionTop) throw new Error("Welcome scrolling moved the pane caption.");
      }
      welcomes[0]!.setAttribute("data-welcome-scroll-proof", "passed");
    });
  };
  const observer = new MutationObserver(advance);
  observer.observe(document.body, { childList: true, subtree: true });
  advance();
  return () => { stopped = true; observer.disconnect(); };
};
