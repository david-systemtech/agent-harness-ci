import type { SceneModule } from "./scene-registry.js";

export const phoneConnectionsScene = (kind: "machines" | "access" | "custom"): SceneModule => ({
  platform: "web",
  script: { environments: [{ name: "desk", reach: "paired", scopes: kind === "custom" ? ["read", "sessions:write", "runs:drive", "admin"] : ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" } }] },
  presentation: { settingsRow: kind === "access" ? "environments.access" : "environments.machines" },
  arrangeWeb: world => {
    world.environment("desk").wire.answer("web.origins.get", () => ({ result: { clientOrigins: [], connectOrigins: [] } }));
  },
  activate: () => {
    let opened = false;
    const advance = () => {
      if (!opened) {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]');
        if (!button) return;
        opened = true; button.click();
      }
      if (kind === "custom") {
        const choice = document.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Custom"]');
        if (!choice || choice.disabled) return;
        if (choice.getAttribute("aria-checked") !== "true") choice.click();
      }
    };
    const observer = new MutationObserver(advance);
    observer.observe(document.body, { childList: true, subtree: true }); advance();
    return () => observer.disconnect();
  },
  readySelector: kind === "custom" ? '[role="group"][aria-label="Scopes"]' : '[data-connection-grant]',
  geometry: ({ width, height }) => [
    { selector: "[data-settings-dialog]", width, height, visibleWithin: "body" },
    { selector: "[data-settings-dialog] button", renderedOnly: true, minimumHeight: 44, minimumWidth: 44 },
    { selector: '[data-settings-dialog] label:has([role="checkbox"])', renderedOnly: true, minimumHeight: 44 },
    { selector: "[data-connection-grant]", renderedOnly: true, maxWidth: width - 24 },
  ],
});
