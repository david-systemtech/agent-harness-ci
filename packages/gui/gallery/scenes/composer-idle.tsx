import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneGeometry } from "../scene-registry.js";
import { presentation, script as windowScript } from "./window-session.js";

export { presentation };
export const script: Script = { environments: windowScript.environments.map((environment) => ({ ...environment, sessions: environment.sessions?.slice(0, 1) ?? [] })) };

/** look.md §10.4: shared 920px column, x12 card inset, 44px field, 22px chips and 28px actions. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-composer-column]", width: 920, viewport: 1400 },
  { selector: "[data-composer-column]", width: 777, viewport: 1024 },
  { selector: "[data-composer-card]", width: 896, viewport: 1400 },
  { selector: "[data-composer-card]", width: 753, viewport: 1024 },
  { selector: '[aria-label="Message"]', height: 44 },
  { selector: '[aria-label="Attach files"]', width: 28, height: 28 },
  { selector: '[aria-label="Send"]', width: 28, height: 28 },
  { selector: "[data-workspace-chip]", height: 22 },
  { selector: "[data-handoff-chip]", height: 22 },
  { selector: "[data-activity-seam]", height: 1 },
];
