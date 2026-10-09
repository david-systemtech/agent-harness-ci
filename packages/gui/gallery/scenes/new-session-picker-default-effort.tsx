import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneGeometry } from "../scene-registry.js";
import { openChip, script as desk } from "../new-session-picker-scene.js";

export { presentation } from "../new-session-picker-scene.js";

/**
 * The new-session surface's model chip open on an environment whose default
 * effort is High (#1950): before any effort is chosen, the Effort column
 * ticks High as the default effort and the chip reads "Fable 5.1 - High",
 * the effort the first run goes out at.
 */
export const script: Script = { environments: desk.environments.map((environment) => ({ ...environment, settings: { "accounts.defaultEffort": "high" } })) };
export const activate = openChip("Models", false);
export const readySelector = '[data-run-column="Effort"] [role="menuitem"][title*="the default effort"]';

export const geometry: readonly SceneGeometry[] = [
  { selector: '[data-run-column="Accounts"]', width: 224 },
  { selector: '[data-run-column="Models"]', width: 256 },
  { selector: '[data-run-column="Effort"]', width: 256 },
];
