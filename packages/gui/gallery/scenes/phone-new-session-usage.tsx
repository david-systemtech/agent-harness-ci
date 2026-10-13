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
export const geometry = [
  { selector: '[aria-label="Where it starts"] [aria-label="Plan usage"] svg[role="img"]', width: 24, height: 24, visibleWithin: "[data-new-session]" },
  { selector: '[aria-label="Where it starts"] button[aria-label="Usage details"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-new-session]" },
];
