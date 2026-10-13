import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import { script as sessions, presentation as layout, geometry as checks } from "../caption-pull-requests-scene.js";
export { activate, readySelector } from "../caption-pull-requests-scene.js";

// The resizer clamps this deliberately small share to its supported 360px floor.
export const script: Script = { environments: sessions.environments.map(environment => ({ ...environment, icon: "laptop" })) };
export const presentation: Partial<PresentationValues> = { textSize: 20, paneLayout: {
  focused: "pane-1", rows: [{ id: "row-1", height: 100, panes: layout.paneLayout!.rows.flatMap(row => row.panes.map(pane => ({ ...pane, width: pane.id === "pane-1" ? 1 : 99 }))) }],
} };
export const geometry = [
  ...checks.map(check => check.selector === "[data-caption-title] button" ? { ...check, contentFits: false } : check),
  { selector: '[data-grid-card="pane-1"]', width: 360 },
  { selector: '[data-grid-card="pane-1"] [data-caption-workspace-name]', minimumWidth: 32, visibleWithin: "[data-caption-identity] [role=note]" },
];
