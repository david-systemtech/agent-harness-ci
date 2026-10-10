import type { SceneModule } from "./scene-registry.js";
import type { EnvironmentHandle } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { CarryOverInventory } from "@agent-harness/contracts";

/** Real browser Settings and checklist, driven by taps over scripted provider state. */
export const phoneSettingsScene = (kind: "constrained" | "full" | "setup" | "picker" | "qr"): SceneModule => {
  let environment: EnvironmentHandle;
  return {
    platform: "web",
    script: { environments: [{ name: "desk", reach: "paired", ...(kind === "constrained" && { scopes: ["read", "sessions:write", "runs:drive"] }), hello: { ceiling: kind === "constrained" ? "acceptEdits" : "bypassPermissions" }, accounts: [{ label: "Project account with a long descriptive label", status: { state: "expired", checkedAt: null, detail: null } }] }] },
    presentation: { settingsRow: kind === "picker" ? "accounts.default-model" : "accounts.accounts" },
    arrangeWeb: world => {
      environment = world.environment("desk");
      if (kind === "setup") environment.wire.answer("carryOver.inventory", params => {
        if (typeof params["accountId"] !== "string") return { result: { accounts: [], failed: [], later: [] } };
        const inventory: CarryOverInventory = {
          accountId: params["accountId"], sessions: { total: 24, archived: 6, missingDirectory: 2, new: 8 },
          memory: { folders: 7, repositories: 3, unmappable: [], new: 2 },
          skills: { skills: 5, commands: 2, new: 3, offered: [], invalid: 1 },
          notCarried: [], doesNotCarry: { hooks: 2, mcpServers: 1, permissionRules: 3 },
        };
        return { result: inventory };
      });
    },
    activate: () => {
      let settingsOpened = false;
      let actionOpened = false;
      let providerReady = false;
      const advance = () => {
        if (!settingsOpened) {
          const settings = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]');
          if (settings === null) return;
          settingsOpened = true; settings.click();
          return;
        }
        if (kind === "constrained") return;
        if (kind === "picker") {
          if (!actionOpened) {
            const trigger = document.querySelector<HTMLButtonElement>('[data-default-choice="Default account"]');
            if (!trigger || trigger.disabled) return;
            actionOpened = true;
            trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" }));
          }
          if (document.querySelector('[aria-label="New-session defaults"] [role="menuitem"]')) observer.disconnect();
          return;
        }
        if (!actionOpened) {
          const action = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-pane] button")).find(button => (kind === "full" || kind === "qr") ? button.textContent === "Sign in again" : button.textContent === "Open the Carry over step in Set up");
          if (!action || action.disabled) return;
          actionOpened = true; action.click();
          return;
        }
        if ((kind === "full" || kind === "qr") && !providerReady && document.querySelector("[data-account-sign-in]")) {
          providerReady = true;
          environment.signIn("awaiting-code", { url: "https://provider.example.test/verify?request=scripted-phone-sign-in" });
        }
        const code = document.querySelector<HTMLInputElement>("[data-account-sign-in] input");
        if ((kind === "full" || kind === "qr") && providerReady && code) {
          const qr = document.querySelector('[aria-label="QR code of the Claude sign-in page"]');
          if (qr === null) return;
          (kind === "qr" ? qr : code.closest("form"))?.scrollIntoView({ block: "nearest" });
          code.closest("[data-account-sign-in]")?.setAttribute("data-phone-sign-in-ready", "");
          observer.disconnect();
        }
      };
      const observer = new MutationObserver(advance);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      advance();
      return () => observer.disconnect();
    },
    readySelector: kind === "picker" ? '[aria-label="New-session defaults"] [role="menuitem"]' : kind === "constrained" ? "[data-phone-grant-guidance]" : (kind === "full" || kind === "qr") ? "[data-phone-sign-in-ready]" : '[data-phone-setup] [data-count-grid][aria-label="Sessions"]',
    geometry: ({ width, height }) => kind === "setup" ? [
      { selector: "[data-phone-setup]", width, height },
      { selector: '[aria-label="Step navigation"] button', minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-phone-setup]" },
      { selector: "[data-phone-setup] footer button", minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-phone-setup]" },
      { selector: '[data-phone-setup] label:has(input[type="checkbox"])', minimumHeight: 44 },
    ] : [
      { selector: "[data-settings-dialog]", width, height, visibleWithin: "body" },
      { selector: "[data-settings-dialog] button", renderedOnly: true, minimumHeight: 44, minimumWidth: 44 },
      ...(kind === "picker" ? [{ selector: '[aria-label="New-session defaults"] [role="menuitem"]', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, visibleWithin: '[aria-label="New-session defaults"]' }] : []),
      ...(kind === "qr" ? [{ selector: '[aria-label="QR code of the Claude sign-in page"]', minimumWidth: 176, minimumHeight: 176, visibleWithin: "[data-settings-scroll]" }] : []),
      ...(kind === "full" ? [{ selector: "[data-account-sign-in] input", minimumHeight: 44, visibleWithin: "[data-settings-scroll]" }, { selector: '[data-account-sign-in] form[aria-label="Send the code"] button[type="submit"]', minimumHeight: 44, visibleWithin: "[data-settings-scroll]" }, { selector: "[data-account-sign-in] a", minimumHeight: 44 }] : []),
    ],
  };
};
