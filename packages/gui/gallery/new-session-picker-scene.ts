import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../src/presentation.js";
import type { RunStage } from "../src/status/run-picker-parts.js";

/**
 * The new-session surface's account and model picker (#1894), opened from
 * its chip over a desk with three accounts, two with plan windows, and a
 * catalogue with no favourite pinned: the usage rings, the recommended
 * models with the pin hint, and Other models, as the status line's picker
 * draws them.
 */

const environmentId = "0199cc00-0000-4000-8000-000000001894";
const identity = (email: string) => ({ provider: "claude", email, organisation: null });
const accounts = [
  { id: "account-1", label: "Work", identity: identity("work@example.test") },
  { id: "account-2", label: "Personal", identity: identity("personal@example.test") },
  { id: "account-3", label: "Spare", identity: identity("spare@example.test"), status: { state: "expired" as const, checkedAt: null, detail: null } },
];
// The provider's own aliases, named from the client runtime's display table (#1824), then samples for Other models.
const models = [
  { id: "fable", family: "fable", tier: 14, label: "Fable", efforts: ["low", "medium", "high"] },
  { id: "opus", family: "opus", tier: 13, label: "Opus", efforts: ["low", "medium", "high"] },
  { id: "sonnet", family: "sonnet", tier: 12, label: "Sonnet", efforts: ["low", "medium", "high"] },
  { id: "haiku", family: "haiku", tier: 11, label: "Haiku", efforts: [] },
  ...Array.from({ length: 7 }, (_, index) => ({ id: `sample-model-${index + 1}`, family: "sample", tier: index, label: `Sample model ${index + 1}`, efforts: [] })),
];

const scriptOn = (reach: "local" | "paired"): Script => ({ environments: [{ environmentId, name: "desk", reach, icon: "desktop", colour: "teal", sessions: [], accounts,
  models: [{ accountId: "account-1", live: true, models }, { accountId: "account-2", live: true, models }] }] });
/** The desktop's scene runs desk on this machine; a phone's, paired, as a browser reaches it. */
export const script = scriptOn("local");
export const pairedScript = scriptOn("paired");

export const presentation: Partial<PresentationValues> = {
  paneLayout: {
    rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: null,
      newSession: { id: "0199dd00-0000-4000-8000-000000001894", focus: { kind: "environment", environmentId }, chips: {} },
    }] }],
    focused: "pane-1",
  },
};

const usageWindow = (window: string, utilisation: number) => ({ window, utilisation, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null });
/** Two plan windows on Work, one on Personal, none on the signed-out Spare: the rows keep one height (#1822). */
export const arrangeUsage = (world: ScriptedWorld) => world.environment("desk").setUsage([
  { accountId: "account-1", identity: identity("work@example.test"), readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null, windows: [usageWindow("five_hour", 0.42), usageWindow("seven_day", 0.67)] },
  { accountId: "account-2", identity: identity("personal@example.test"), readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null, windows: [usageWindow("five_hour", 0.95)] },
]);

/**
 * Opens the chip of `stage` once the surface's presets are in: on the
 * desktop as a keyboard does (Enter), on a phone with a tap, which opens
 * its sheet.
 */
export const openChip = (stage: Exclude<RunStage, "Effort">, phone: boolean) => () => {
  let opened = false;
  const show = () => {
    const chip = document.querySelector<HTMLButtonElement>(`[data-new-session-chip][aria-label^="${stage === "Accounts" ? "Account" : "Model"}:"]`);
    if (opened || !chip || chip.getAttribute("aria-label")?.endsWith(": none") || !chip.hasAttribute("data-state")) return;
    opened = true;
    if (phone) return chip.click();
    chip.focus();
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  };
  const observer = new MutationObserver(show);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  show();
  return () => observer.disconnect();
};
