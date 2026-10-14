import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { arrange, readySelector, script as base } from "./new-session.js";

export { presentation } from "./new-session.js";

/**
 * The new-session surface on a phone with the chosen account's plan usage (#2100): the run settings a session's status line
 * keeps in a sheet are chips here, so the meter stays in their row, its rings visible and its details a tap away.
 */
export const platform = "web";
export const script: Script = { environments: base.environments.map((environment) => ({ ...environment, reach: "paired" })) };
export const arrangeWeb = arrange;
export { readySelector };
/**
 * The rings are 24px at every phone text size, text size 20 included: look.md keeps the phone root rem at 16px and scales type
 * alone, so the ring's 1.5rem box does not grow. A head branched before that rule (#2148) measures 24 × 20 / 14 = 34.28px (#2184).
 */
export const geometry = [
  { selector: '[aria-label="Where it starts"] [aria-label="Plan usage"] svg[role="img"]', width: 24, height: 24, visibleWithin: "[data-new-session]" },
  { selector: '[aria-label="Where it starts"] button[aria-label="Usage details"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-new-session]" },
];
