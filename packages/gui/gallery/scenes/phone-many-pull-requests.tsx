import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { script as desktopScript } from "../caption-pull-requests-scene.js";
export { route } from "./phone-gallery-conversation.js";
export const platform = "web";
export const script: Script = { environments: desktopScript.environments.map(environment => ({ ...environment, reach: "paired" as const })) };
export const readySelector = "[data-header-session-title]";
export const geometry = [
  { selector: "[data-header-session-title]", minimumWidth: 80, visibleWithin: "[data-window-header]" },
  { selector: ".phone-frame-header button", minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-window-header]" },
];
