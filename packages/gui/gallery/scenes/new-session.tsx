import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000055";
export const script: Script = { environments: [{
  environmentId, name: "desk", reach: "local", icon: "desktop", colour: "teal", sessions: [],
  accounts: [{ id: "sample-account", label: "Work", identity: { provider: "claude", email: "account@example.test", organisation: null } }],
  models: [{ accountId: "sample-account", live: true, models: [{ id: "sample-model", label: "Sample model", family: "sample", tier: 1, efforts: [] }] }],
}] };

export const presentation: Partial<PresentationValues> = {
  paneLayout: {
    rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: null,
      newSession: { id: "0199dd00-0000-4000-8000-000000000055", focus: { kind: "environment", environmentId }, chips: {} },
    }] }],
    focused: "pane-1",
  },
};

/** look.md §10.4–10.5 and §14: one composer/status column and fixed actions, chips and welcome tile. */
export const composerGeometry: readonly SceneGeometry[] = [
  { selector: "[data-welcome-tile]", width: 44, height: 44 },
  { selector: "[data-welcome-tile] svg", width: 22, height: 22 },
  { selector: "[data-composer-column]", width: 920, viewport: 1400 },
  { selector: "[data-composer-column]", width: 777, viewport: 1024 },
  { selector: "[data-composer-card]", width: 896, viewport: 1400 },
  { selector: "[data-composer-card]", width: 753, viewport: 1024 },
  { selector: '[aria-label="Message"]', height: 44 },
  { selector: '[aria-label="Send"]', width: 28, height: 28 },
  { selector: '[aria-label="Where it starts"] fieldset button', height: 22 },
  { selector: '[aria-label="Where it starts"] fieldset button svg', width: 12, height: 12 },
];

/** The selected account's provider windows use the same 24px rings as a running session (#2100). */
export const arrange = (world: ScriptedWorld) => world.environment("desk").setUsage([{
  accountId: "sample-account", identity: { provider: "claude", email: "account@example.test", organisation: null },
  readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null,
  windows: [
    { window: "five_hour", utilisation: 0.42, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null },
    { window: "seven_day", utilisation: 0.67, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-30T00:00:00.000Z", verdict: null },
  ],
}]);
export const readySelector = '[aria-label="Where it starts"] [aria-label="Plan usage"] [role="img"]';
export const geometry: readonly SceneGeometry[] = [
  ...composerGeometry,
  { selector: '[aria-label="Where it starts"] [aria-label="Plan usage"]', visibleWithin: "[data-composer-column]", contentFits: true },
  { selector: '[aria-label="Where it starts"] [aria-label="Plan usage"] svg[role="img"]', width: 24, height: 24 },
];
