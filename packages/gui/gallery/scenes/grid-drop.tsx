import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { createGridWorld } from "./grid-two.js";

const { prepared, holders } = await createGridWorld();

export default function GridDrop({ ladder }: { readonly ladder: LadderName }) {
  useEffect(() => {
    holders.presentation.set("lightOrDark", ladder);
    const transfer = { setData: () => {}, effectAllowed: "move", dropEffect: "move" };
    let started = false;
    const start = () => {
      if (started) {
        const target = document.querySelector('[data-drop-zone][aria-label="Move to the right"]');
        if (target === null) return;
        observer.disconnect();
        target.dispatchEvent(Object.assign(new Event("dragover", { bubbles: true, cancelable: true }), { dataTransfer: transfer }));
        return;
      }
      const caption = document.querySelector('[data-grid-card="pane-1"] [data-pane-caption]');
      if (caption === null) return;
      started = true;
      caption.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: transfer }));
    };
    const observer = new MutationObserver(start);
    observer.observe(document.body, { childList: true, subtree: true });
    start();
    return () => observer.disconnect();
  }, [ladder]);
  useEffect(() => () => {
    holders.stopFollowing();
    void holders.presentation.close();
    void holders.runtime.close();
  }, []);
  return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
}

/** docs/specs/look.md §9.3: centre/right/bottom targets with dashed labels. */
export const geometry = [
  // The target occupies 28% of a card's content width, excluding its two borders.
  { selector: '[data-drop-zone][aria-label="Move to the right"]', width: ((window.innerWidth - 252) / 2 - 2) * 0.28, tolerance: 1 },
  { selector: "[data-drop-label]" },
  { selector: "[data-pane-caption]", height: 32 },
];
