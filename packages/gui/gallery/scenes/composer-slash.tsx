import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { geometry as idleGeometry, presentation, script as idleScript } from "./composer-idle.js";

export { presentation };
export const script: Script = { environments: idleScript.environments.map((environment) => ({ ...environment, sessions: environment.sessions?.map((session) => ({ ...session, draft: "/" })) ?? [] })) };
export const geometry = [...idleGeometry, { selector: '[data-composer-menu] [role="option"]', height: 28 }];
