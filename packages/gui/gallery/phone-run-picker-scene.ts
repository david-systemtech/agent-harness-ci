import type { SceneModule } from "./scene-registry.js";
import type { RunStage } from "../src/status/run-picker-parts.js";

/** The real session chips and phone sheet, with long account and model labels; with `otherModels`, Other models tapped open under its row (#1821). */
export const phoneRunPickerScene = (stage: RunStage, otherModels = false): SceneModule => ({
  platform: "web",
  script: { environments: [{ name: "desk", reach: "paired", accounts: [
    { id: "account-1", label: "Project account with a long descriptive label", identity: { provider: "claude", email: "project-account@example.test", organisation: null } },
    { id: "account-2", label: "Personal account", identity: { provider: "claude", email: "personal@example.test", organisation: null } },
  ], models: [{ accountId: "account-1", live: true, models: [
    { id: "sample-model-with-a-long-identifier", label: "Sample model with a long descriptive name", family: "sample", tier: 1, efforts: ["low", "medium", "high"] },
    { id: "sample-model-quick", label: "Sample quick model", family: "quick", tier: 0, efforts: [] },
    { id: "sample-model-wide-context", label: "Sample model with a wide context", family: "sample", tier: 1, efforts: ["low", "medium", "high"] },
    { id: "sample-model-previous", label: "Sample previous model", family: "previous", tier: 0, efforts: [] },
  ] }], sessions: [{ title: "Check the receipts", accountId: "account-1", model: "sample-model-with-a-long-identifier" }],
  // One favourite pinned: it heads the models, the session's own model after it, the other two under Other models.
  settings: { "accounts.favouriteModels": ["sample-model-quick"] } }] },
  route: world => ({ session: { environmentId: world.environment("desk").environmentId, sessionId: world.environment("desk").sessionId() } }),
  activate: () => {
    let expanded = false;
    let opened = false;
    let advanced = false;
    let tapped = false;
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
      if (otherModels && !tapped) {
        const flyout = document.querySelector<HTMLElement>('[data-run-sheet] [role="menuitem"][aria-label="Other models"]');
        if (!flyout) return;
        tapped = true;
        flyout.click();
      }
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    show();
    return () => observer.disconnect();
  },
  readySelector: otherModels ? "[data-other-models-list]" : `[data-run-sheet] [data-run-column="${stage}"]:not([hidden])`,
  geometry: ({ width }) => [
    { selector: "[data-run-sheet]", width: width - 16, visibleWithin: "[data-run-sheet]" },
    { selector: '[data-run-sheet] [role="menuitem"]', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, contentFits: true },
    { selector: '[data-run-sheet] button', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, visibleWithin: '[data-run-sheet]' },
    ...otherModels ? [{ selector: '[data-other-models-list] [role="menuitem"]', renderedOnly: true, minimumHeight: 44, minimumWidth: 44, contentFits: true, hitTestable: true }] : [],
  ],
});
