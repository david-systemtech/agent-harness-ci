import { verifyKeyboardDock } from "../phone-keyboard-dock-geometry.js";
import { safeAreas } from "../phone-frame-scene.js";
export { platform, script, route } from "../phone-frame-scene.js";
export { arrangeWeb } from "./phone-keyboard-dock.js";

/** The capture harness resizes the page itself, so the layout viewport and VisualViewport shrink together. */
type LayoutViewport = (width: number, height: number) => Promise<void>;

export const readySelector = "[data-layout-keyboard-proof]";
export const geometry = [
  { selector: '[aria-label="Transcript"]', minimumHeight: 84, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Send"]', minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-web-client]" },
];

/**
 * A keyboard that resizes the layout (Firefox on Android, `interactive-widget=resizes-content`; #1737):
 * Message focused then 844 → 480, back to 844 with focus kept, and the reverse order, ending at 480.
 */
export const activate = () => {
  const stopInsets = safeAreas()();
  let stopped = false, started = false;
  const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const resize = async (height: number) => {
    const layoutViewport = (window as { galleryLayoutViewport?: LayoutViewport }).galleryLayoutViewport;
    if (!layoutViewport) throw new Error("Layout keyboard proof needs the capture harness's galleryLayoutViewport");
    await layoutViewport(390, height);
    while (innerHeight !== height) await settle();
    await settle();
  };
  const run = async () => {
    await document.fonts.ready;
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    // Planned at the keyboard height, so the capture and hosted geometry show the keyboard-open layout.
    if (innerWidth !== 390 || innerHeight !== 480) throw new Error("Layout keyboard proof is planned at 390x480");
    await resize(844);
    field.focus(); await settle(); verifyKeyboardDock(844, 0);
    await resize(480); verifyKeyboardDock(480, 0);
    // Closing restores the whole layout on its own resize, without a later event.
    await resize(844); verifyKeyboardDock(844, 0);
    if (document.activeElement !== field) throw new Error("Keyboard close lost focus");
    field.blur(); await settle();
    await resize(480);
    field.focus(); await settle(); verifyKeyboardDock(480, 0);
    if (!stopped) document.querySelector("[data-web-client]")!.setAttribute("data-layout-keyboard-proof", "passed");
  };
  const start = () => {
    started = true;
    observer.disconnect();
    void run().catch(error => {
      if (stopped) return;
      // A failed proof reaches capture's page-error gate rather than a readiness timeout.
      document.querySelector("[data-web-client]")!.setAttribute("data-layout-keyboard-proof", "failed");
      queueMicrotask(() => { throw error; });
    });
  };
  const observer = new MutationObserver(() => {
    if (!started && document.querySelector('[aria-label="Message"]')) start();
  });
  observer.observe(document.body, { subtree: true, childList: true });
  if (document.querySelector('[aria-label="Message"]')) start();
  return () => { stopped = true; observer.disconnect(); stopInsets(); };
};
