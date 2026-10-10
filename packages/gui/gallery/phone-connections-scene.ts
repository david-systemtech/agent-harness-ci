import type { SceneModule } from "./scene-registry.js";

export const phoneConnectionsScene = (kind: "machines" | "access" | "custom"): SceneModule => ({
  platform: "web",
  script: { environments: [{ name: "desk", reach: "paired", scopes: kind === "custom" ? ["read", "sessions:write", "runs:drive", "admin"] : ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" } }] },
  presentation: { settingsRow: kind === "access" ? "environments.access" : "environments.machines" },
  activate: () => {
    let opened = false;
    let arranged = false;
    let unfolded = false;
    const advance = () => {
      if (!opened) {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]');
        if (!button) return;
        opened = true; button.click();
      }
      if (kind === "custom") {
        const choice = document.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Custom"]');
        // Custom sits under More options (setup-copy.md §5.5).
        if (!choice && !unfolded) {
          const more = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) => button.textContent === "More options");
          if (more) { unfolded = true; more.click(); }
          return;
        }
        if (!choice || choice.disabled) return;
        if (choice.getAttribute("aria-checked") !== "true") { choice.click(); return; }
      }
      const target = document.querySelector<HTMLElement>(kind === "custom" ? '[role="group"][aria-label="What it can do"]' : '[data-connection-grant]');
      if (target && !arranged) {
        arranged = true;
        requestAnimationFrame(() => {
          if (kind === "custom") target.scrollIntoView({ block: "start" });
          else { const scroll = document.querySelector<HTMLElement>("[data-settings-scroll]"); if (scroll) scroll.scrollTop = 0; }
          target.setAttribute("data-phone-connection-ready", "");
        });
      }
    };
    const observer = new MutationObserver(advance);
    observer.observe(document.body, { childList: true, subtree: true }); advance();
    return () => observer.disconnect();
  },
  readySelector: "[data-phone-connection-ready]",
  geometry: ({ width, height }) => [
    { selector: "[data-settings-dialog]", width, height, visibleWithin: "body" },
    { selector: "[data-settings-dialog] button", renderedOnly: true, minimumHeight: 44, minimumWidth: 44 },
    ...(kind === "custom" ? [
      { selector: '[data-settings-dialog] label:has([role="checkbox"])', renderedOnly: true, minimumHeight: 44 },
      { selector: '[role="group"][aria-label="What it can do"]', visibleWithin: "[data-settings-scroll]", contentFits: true },
    ] : []),
    { selector: "[data-connection-grant]", renderedOnly: true, contentFits: true },
  ],
});
