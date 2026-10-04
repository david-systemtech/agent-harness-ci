import type { SceneModule } from "../scene-registry.js";
export { PhoneTerminalScene as default, phoneTerminalGeometry as geometry } from "../phone-terminal-scene.js";
export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive", "terminal"], hello: { ceiling: "acceptEdits" }, sessions: [{}], terminals: [{
  id: "7e000000-0000-4000-8000-000000000001", session: 0,
  output: "$ check receipts\r\n" + Array.from({ length: 40 }, (_, i) => `Receipt ${i + 1}: total agrees\r\n`).join("") + "\x1b[32m40 checks passed\x1b[0m\r\n$ ",
}] }] };
export const readySelector = '[data-terminal-selection-action]';

/** Capture touch selection using the same controls a phone exposes. */
export const activate = () => {
  let selected = false;
  const observer = new MutationObserver(() => {
    if (selected || !document.querySelector(".xterm-fg-2")) return;
    const select = [...document.querySelectorAll("button")].find(button => button.textContent === "Select");
    const overlay = document.querySelector<HTMLElement>('[aria-label="Select terminal text"]');
    if (!overlay) { if (select?.getAttribute("aria-pressed") === "false") select.click(); return; }
    const rect = document.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    selected = true;
    const position = { clientX: rect.left + 2, clientY: rect.top + 2, pointerId: 1, pointerType: "touch", bubbles: true };
    for (const [type, clientX] of [["pointerdown", position.clientX], ["pointermove", rect.left + rect.width / 2], ["pointerup", rect.left + rect.width / 2]] as const) {
      const event = new MouseEvent(type, { ...position, clientX });
      Object.defineProperty(event, "pointerId", { value: position.pointerId });
      overlay.dispatchEvent(event);
    }
    observer.disconnect();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  return () => observer.disconnect();
};
