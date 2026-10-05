import type { SceneModule } from "./scene-registry.js";
import type { RunStage } from "../src/status/run-picker-parts.js";

/** The real session chips and phone sheet, with long account and model labels. */
export const phoneRunPickerScene = (stage: RunStage): SceneModule => ({
  platform: "web",
  script: { environments: [{ name: "desk", reach: "paired", accounts: [
    { id: "account-1", label: "Project account with a long descriptive label", identity: { provider: "claude", email: "project-account@example.test", organisation: null } },
    { id: "account-2", label: "Personal account", identity: { provider: "claude", email: "personal@example.test", organisation: null } },
  ], models: [{ accountId: "account-1", live: true, models: [
    { id: "sample-model-with-a-long-identifier", label: "Sample model with a long descriptive name", family: "sample", tier: 1, efforts: ["low", "medium", "high"] },
  ] }], sessions: [{ title: "Check the receipts", accountId: "account-1", model: "sample-model-with-a-long-identifier" }] }] },
  route: world => ({ session: { environmentId: world.environment("desk").environmentId, sessionId: world.environment("desk").sessionId() } }),
  activate: () => {
    let expanded = false;
    let opened = false;
    let advanced = false;
    const show = () => {
      if (!expanded) {
        const settings = document.querySelector<HTMLButtonElement>('[data-phone-status-toggle], [data-phone-composer-toolbar] [aria-label="Run settings"]');
        if (!settings) return;
        expanded = true;
        settings.click();
        return;
      }
      if (!document.querySelector('[data-phone-status="open"], [data-phone-run-settings]')) return;
      if (!opened) {
        const chip = document.querySelector<HTMLButtonElement>(`[aria-label^="${stage === "Accounts" ? "Account" : "Model"}:"]`);
        if (!chip || !chip.hasAttribute("data-state") || chip.getAttribute("aria-disabled") === "true") return;
        opened = true;
        chip.click();
      }
      if (stage === "Effort" && !advanced) {
        const next = document.querySelector<HTMLButtonElement>('[data-run-sheet] [aria-label="Next: Effort"]');
        if (!next) return;
        advanced = true;
        next.click();
      }
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    show();
    return () => observer.disconnect();
  },
  readySelector: `[data-run-sheet] [data-run-column="${stage}"]:not([hidden])`,
  geometry: ({ width }) => [
    { selector: "[data-run-sheet]", width: width - 16, visibleWithin: "[data-run-sheet]" },
    { selector: '[data-run-sheet] [role="menuitem"]', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, contentFits: true },
    { selector: '[data-run-sheet] button', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, visibleWithin: '[data-run-sheet]' },
  ],
});
