import type { SceneModule } from "./scene-registry.js";
import { SCOPES } from "@agent-harness/contracts";

export const phoneConnectionsScene = (kind: "machines" | "access" | "custom" | "pairing"): SceneModule => ({
  platform: "web",
  script: { environments: [{ name: "desk", reach: "paired", scopes: kind === "pairing" ? [...SCOPES] : kind === "custom" ? ["read", "sessions:write", "runs:drive", "admin"] : ["read", "sessions:write", "runs:drive"], hello: { ceiling: kind === "pairing" ? "bypassPermissions" : "acceptEdits" },
    ...(kind === "pairing" && { status: { binding: { tailnet: null, tailnetFound: null, tailscaleInstalled: false, lan: null, lanAddresses: [], webOrigin: "https://pairing-server.example.test:8443" } } }),
  }] },
  presentation: { settingsRow: kind === "access" ? "environments.access" : "environments.machines" },
  activate: () => {
    let opened = false;
    let arranged = false;
    let unfolded = false;
    let minted = false;
    const advance = () => {
      if (!opened) {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]');
        if (!button) return;
        opened = true; button.click();
      }
      if (kind === "pairing") {
        const part = Array.from(document.querySelectorAll("section[aria-labelledby]")).find(section => section.querySelector(":scope > h4")?.textContent === "Pair another client");
        if (!minted) {
          const button = Array.from(part?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(button => button.textContent === "Make a pairing code");
          if (!button || button.disabled) return;
          minted = true; button.click();
          return;
        }
        const code = part?.querySelector<HTMLElement>('[role="group"][aria-label="Pairing code"]');
        const manual = Array.from(code?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(button => button.textContent === "Type it instead");
        if (!code || !manual) return;
        if (manual.getAttribute("aria-expanded") !== "true") { manual.click(); return; }
        if (!arranged && code.querySelectorAll("pre").length === 3) {
          arranged = true;
          requestAnimationFrame(() => {
            code.scrollIntoView({ block: "start" });
            code.dataset["measure"] = "pairing-group";
            code.querySelector<HTMLElement>(".pairing-code-details")!.dataset["measure"] = "pairing-details";
            code.setAttribute("data-phone-connection-ready", "");
          });
        }
        return;
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
    ...(kind === "pairing" ? [
      { selector: ".pairing-code-details", minimumWidth: width - 120, below: '[aria-label="QR code of the pairing link"]', contentFits: true },
      { selector: ".pairing-code-details pre", contentFits: true },
      { selector: '.pairing-code-details [role="timer"]', wordsIntact: true },
      { selector: '[aria-label="Close Settings"]', hitTestable: true, visibleWithin: "[data-settings-dialog]" },
    ] : []),
  ],
});
