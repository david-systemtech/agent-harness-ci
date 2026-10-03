import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
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
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-welcome-tile]", width: 44, height: 44 },
  { selector: "[data-welcome-tile] svg", width: 22, height: 22 },
  { selector: "[data-composer-column]", width: 920, viewport: 1400 },
  { selector: "[data-composer-column]", width: 777, viewport: 1024 },
  { selector: "[data-composer-card]", width: 896, viewport: 1400 },
  { selector: "[data-composer-card]", width: 753, viewport: 1024 },
  { selector: '[aria-label="Message"]', height: 44 },
  { selector: '[aria-label="Send"]', width: 28, height: 28 },
  { selector: '[aria-label="Where it starts"] button', height: 22 },
  { selector: '[aria-label="Where it starts"] button svg', width: 12, height: 12 },
];
