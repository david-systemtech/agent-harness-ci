import type { SceneModule } from "./scene-registry.js";
import type { EnvironmentHandle } from "@agent-harness/client-runtime/testing/scripted-environment";

/** Real browser Settings and checklist, driven by taps over scripted provider state. */
export const phoneSettingsScene = (kind: "constrained" | "full" | "setup"): SceneModule => {
  let environment: EnvironmentHandle;
  return {
    platform: "web",
    script: { environments: [{ name: "desk", reach: "paired", ...(kind === "constrained" && { scopes: ["read", "sessions:write", "runs:drive"] }), hello: { ceiling: kind === "constrained" ? "acceptEdits" : "bypassPermissions" }, accounts: [{ label: "Project account with a long descriptive label", status: { state: "expired", checkedAt: null, detail: null } }] }] },
    presentation: { settingsRow: "accounts.accounts" },
    arrangeWeb: world => { environment = world.environment("desk"); },
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
        if (!actionOpened) {
          const action = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-pane] button")).find(button => kind === "full" ? button.textContent === "Sign in again" : button.textContent === "Open the Carry over step in Set up");
          if (!action || action.disabled) return;
          actionOpened = true; action.click();
          return;
        }
        if (kind === "full" && !providerReady && document.querySelector("[data-account-sign-in]")) {
          providerReady = true;
          environment.signIn("awaiting-code", { url: "https://provider.example.test/verify?request=scripted-phone-sign-in" });
        }
        const code = document.querySelector<HTMLInputElement>("[data-account-sign-in] input");
        if (kind === "full" && providerReady && code) {
          code.scrollIntoView({ block: "nearest" });
          code.closest("[data-account-sign-in]")?.setAttribute("data-phone-sign-in-ready", "");
          observer.disconnect();
        }
      };
      const observer = new MutationObserver(advance);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      advance();
      return () => observer.disconnect();
    },
    readySelector: kind === "constrained" ? "[data-phone-grant-guidance]" : kind === "full" ? "[data-phone-sign-in-ready]" : "[data-phone-setup] footer",
    geometry: ({ width, height }) => kind === "setup" ? [
      { selector: "[data-phone-setup]", width, height },
      { selector: '[aria-label="Step navigation"] button', minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-phone-setup]" },
    ] : [
      { selector: "[data-settings-dialog]", width, height, visibleWithin: "body" },
      { selector: "[data-settings-dialog] button", renderedOnly: true, minimumHeight: 44, minimumWidth: 44 },
      ...(kind === "full" ? [{ selector: "[data-account-sign-in] input", minimumHeight: 44, visibleWithin: "[data-settings-scroll]" }, { selector: "[data-account-sign-in] a", minimumHeight: 44 }] : []),
    ],
  };
};
