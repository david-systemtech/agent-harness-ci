import type { SceneModule } from "./scene-registry.js";
import type { RunStage } from "../src/status/run-picker-parts.js";

const usage = (accountId: string, email: string, windows: readonly (readonly [string, number])[]) => ({
  accountId, identity: { provider: "claude", email, organisation: null }, readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null,
  windows: windows.map(([window, utilisation]) => ({ window, utilisation, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null })),
});

/** The real session chips and phone sheet, with long account and model labels; with `otherModels`, Other models tapped open as the list's page (#1821). */
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
  // Two plan windows on the long-labelled account and one on the other, as rings in a 360px sheet (#1822).
  arrangeWeb: world => world.environment("desk").setUsage([
    usage("account-1", "project-account@example.test", [["five_hour", 0.8], ["seven_day", 0.35]]),
    usage("account-2", "personal@example.test", [["five_hour", 0.95]]),
  ]),
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
    // The ring line scales with the text size, so here it is checked to fit the sheet, not for its 16px.
    ...(stage === "Accounts" ? [{ selector: "[data-run-sheet] [data-usage-rings]", renderedOnly: true, visibleWithin: "[data-run-sheet]" },
      // The 28-character address stays on one line (#1895).
      { selector: "[data-run-sheet] [data-run-identity]", renderedOnly: true, unbroken: true }] : []),
  ],
});
