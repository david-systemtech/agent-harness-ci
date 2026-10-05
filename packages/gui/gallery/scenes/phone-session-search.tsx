import type { SceneModule } from "../scene-registry.js";
import { safeAreas } from "../phone-frame-scene.js";
import { verifySessionSearch } from "../phone-session-search-geometry.js";
export { route } from "./phone-gallery-conversation.js";
export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: Array.from({ length: 36 }, (_, index) => ({ title: `Receipt ${String(index + 1).padStart(2, "0")} with a long title for the searchable session list` })) }] };
export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk");
  env.startRun(env.sessionId(), "Keep reviewing receipts while searching");
  env.startRun(env.sessionId(1), "Wait for permission");
  env.openPrompt(env.sessionId(1), { promptId: "search-permission", kind: "permission", summary: "Read the next receipt", toolName: "Bash", input: { command: "printf receipts" } });
};
export const readySelector = '[data-session-search-proof]';
export const geometry = [
  { selector: '.phone-frame-drawer [aria-label="Close sessions"]', minimumHeight: 44, minimumWidth: 44, visibleWithin: '.phone-frame-drawer' },
  { selector: '.phone-frame-drawer [aria-label="New session"]', minimumHeight: 44, visibleWithin: '.phone-frame-drawer' },
  { selector: '.phone-frame-drawer input', minimumHeight: 44, visibleWithin: '.phone-frame-drawer' },
  { selector: '.phone-frame-drawer [data-sidebar-row]', minimumHeight: 44, minimumWidth: 44 },
  { selector: '.phone-frame-drawer [data-sidebar-details]', contentFits: true },
];

export const activate = () => {
  const actual = window.visualViewport;
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const fit = () => (actual ?? window).dispatchEvent(new Event("resize"));
  const stopInsets = safeAreas()();
  let stopped = false;
  const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const run = async () => {
    await document.fonts.ready;
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Show sessions"]')!;
    trigger.click(); await settle();
    const drawer = document.querySelector<HTMLElement>('.phone-frame-drawer')!;
    if (document.activeElement !== drawer) throw new Error("Sessions opens an input keyboard");
    const filter = drawer.querySelector<HTMLInputElement>('[aria-label="Filter the sessions"]')!;
    filter.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "Receipt");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    viewport.height = Math.min(480, innerHeight);
    viewport.offsetTop = innerHeight >= 740 ? 120 : 0;
    fit(); await settle();
    verifySessionSearch(viewport.height, viewport.offsetTop);
    drawer.querySelector<HTMLButtonElement>('[aria-label="Close sessions"]')!.click(); await settle();
    if (document.activeElement !== trigger || window.scrollY !== 0) throw new Error("Session dismissal lost focus or moved the page");
    trigger.click(); await settle();
    if (document.activeElement !== document.querySelector('.phone-frame-drawer')) throw new Error("Reopening sessions focuses an input");
    document.querySelector<HTMLInputElement>('.phone-frame-drawer input')!.focus({ preventScroll: true });
    verifySessionSearch(viewport.height, viewport.offsetTop);
    if (!stopped) document.querySelector('.phone-frame-drawer')!.setAttribute("data-session-search-proof", "passed");
  };
  const start = () => {
    observer.disconnect();
    void run().catch(error => {
      if (stopped) return;
      document.querySelector('[data-web-client]')!.setAttribute("data-session-search-proof", "failed");
      queueMicrotask(() => { throw error; });
    });
  };
  const observer = new MutationObserver(() => { if (document.querySelector('[aria-label="Message"]')) start(); });
  observer.observe(document.body, { subtree: true, childList: true });
  if (document.querySelector('[aria-label="Message"]')) start();
  return () => {
    stopped = true; observer.disconnect(); stopInsets();
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete (window as { visualViewport?: unknown }).visualViewport;
  };
};
