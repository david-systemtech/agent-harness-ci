import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { script as filesScript, dockGeometry } from "./dock-files.js";
export { presentation } from "./dock-files.js";
/** look.md §9.3 and §16: the dock's error list retains its controls. */
export const script: Script = { environments: filesScript.environments.map((environment) => ({ ...environment, files: [] })) };
export const geometry = dockGeometry;
export const arrange = (world: ScriptedWorld) => { world.environment("desk").wire.answer("files.list", () => ({ error: { code: "unavailable", message: "The file list could not be read.", data: {} } })); };
