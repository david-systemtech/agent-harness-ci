import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { BYPASS_SENTENCE } from "@agent-harness/contracts";
import { toast } from "../../src/ui/toaster.js";
import type { SceneGeometry } from "../scene-registry.js";
import { geometry as composerGeometry, script as idleScript } from "./composer-idle.js";

export { presentation } from "./window-session.js";

/** The composer of a session just set to bypassPermissions (#1823): the mode button shows it, the change said once in the transient lane, nothing standing under the composer. */
export const script: Script = { environments: idleScript.environments.map((environment) => ({
  ...environment, sessions: environment.sessions?.map((session) => ({ ...session, mode: "bypassPermissions" as const })) ?? [],
})) };

/** The notice the mode picker says as the mode changes, held for the capture. */
export const activate = () => {
  const id = toast.warning(`Mode: bypassPermissions. ${BYPASS_SENTENCE}`, { duration: Infinity });
  return () => { toast.dismiss(id); };
};

export const readySelector = "[data-sonner-toast]";

export const geometry: readonly SceneGeometry[] = [
  ...composerGeometry,
  { selector: '[aria-label="Status line"] button[aria-label="Mode: BYPASS"]', height: 22 },
  { selector: "[data-sonner-toast]", width: 356 },
];
