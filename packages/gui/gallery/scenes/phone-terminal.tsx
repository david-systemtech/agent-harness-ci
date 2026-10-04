import type { SceneModule } from "../scene-registry.js";
import { phoneTerminalGeometry } from "../phone-terminal-scene.js";
export { PhoneTerminalScene as default } from "../phone-terminal-scene.js";
export const geometry = [...phoneTerminalGeometry, { selector: '[data-terminal-selection-action]:not(:disabled)', minimumHeight: 44, visibleWithin: '[aria-label="Terminal sheet"]' }];
export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive", "terminal"], hello: { ceiling: "acceptEdits" }, sessions: [{}], terminals: [{
  id: "7e000000-0000-4000-8000-000000000001", session: 0,
  output: "$ check receipts\r\n" + Array.from({ length: 40 }, (_, i) => `Receipt ${i + 1}: total agrees\r\n`).join("") + "\x1b[32m40 checks passed\x1b[0m\r\n$ ",
}] }] };
export const readySelector = '[data-terminal-selection-action]:not(:disabled)';

/** Capture touch selection using the same controls a phone exposes. */
export const activate = () => {
  let selected = false;
  let keyboardChecked = window.innerHeight > 480;
  let keyboardChanged = false;
  let initialRows = 0;
  let frame: number | undefined;
  let previous = "";
  let stableFrames = 0;
  const schedule = () => {
    if (!selected && frame === undefined) frame = requestAnimationFrame(settle);
  };
  const settle = () => {
    frame = undefined;
    if (selected || !document.querySelector(".xterm-fg-2")) return;
    const screen = document.querySelector(".xterm-screen")?.getBoundingClientRect();
    const host = document.querySelector('[aria-label="Terminal screen"]')?.getBoundingClientRect();
    if (!screen || !host || screen.width <= 0) return;
    const dimensions = `${screen.x}/${screen.y}/${screen.width}/${screen.height}/${host.x}/${host.y}/${host.width}/${host.height}`;
    stableFrames = dimensions === previous ? stableFrames + 1 : 0;
    previous = dimensions;
    // Selection starts after React layout and the real ResizeObserver/FitAddon settle.
    if (stableFrames < 2) { schedule(); return; }
    if (!keyboardChecked) {
      const rows = document.querySelector(".xterm-rows")?.children.length ?? 0;
      const browserFrame = document.querySelector<HTMLElement>("[data-web-client]");
      if (!browserFrame || rows === 0) return;
      if (!keyboardChanged) {
        initialRows = rows;
        // Keep innerHeight unchanged: only the keyboard's visual viewport shrinks.
        Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 360 });
        keyboardChanged = true;
        window.visualViewport!.dispatchEvent(new Event("resize"));
        stableFrames = 0;
        schedule();
        return;
      }
      // The actual FitAddon and browser layout must reduce the terminal's rows.
      if (Math.abs(browserFrame.getBoundingClientRect().height - 360) > 0.5 || rows >= initialRows) { schedule(); return; }
      keyboardChecked = true;
      browserFrame.dataset["terminalKeyboardFit"] = `${initialRows} → ${rows}`;
    }
    const select = [...document.querySelectorAll("button")].find(button => button.textContent === "Select");
    const overlay = document.querySelector<HTMLElement>('[aria-label="Select terminal text"]');
    if (!overlay) { if (select?.getAttribute("aria-pressed") === "false") select.click(); schedule(); return; }
    const rect = screen;
    selected = true;
    const position = { clientX: rect.left + 2, clientY: rect.top + 2, pointerId: 1, pointerType: "touch", bubbles: true };
    for (const [type, clientX] of [["pointerdown", position.clientX], ["pointermove", rect.left + rect.width / 2], ["pointerup", rect.left + rect.width / 2]] as const) {
      const event = new MouseEvent(type, { ...position, clientX });
      Object.defineProperty(event, "pointerId", { value: position.pointerId });
      overlay.dispatchEvent(event);
    }
    observer.disconnect();
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
};
