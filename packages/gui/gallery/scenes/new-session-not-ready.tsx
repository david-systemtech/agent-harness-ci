import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { script as readyScript } from "./new-session.js";

export { presentation, geometry } from "./new-session.js";
export const script: Script = { environments: readyScript.environments.map((environment) => ({
  ...environment, models: [], accounts: [{ id: "adopted-account", label: "Adopted", status: { state: "signed-out", checkedAt: null, detail: null } }],
})) };
