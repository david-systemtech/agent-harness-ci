import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { script as filesScript, dockGeometry } from "./dock-files.js";
export { presentation } from "./dock-files.js";
/** look.md §9.3 and §16: the dock's empty list retains its controls. */
export const script: Script = { environments: filesScript.environments.map((environment) => ({ ...environment, files: [] })) };
export const geometry = dockGeometry;

