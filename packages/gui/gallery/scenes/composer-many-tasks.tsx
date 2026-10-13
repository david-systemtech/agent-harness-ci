import type { DelegatedWorkRow } from "@agent-harness/contracts";
import type { ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneGeometry } from "../scene-registry.js";
import { geometry as idleGeometry, presentation, script } from "./composer-idle.js";

export { presentation, script };
export const arrange = (world: ScriptedWorld): void => {
  const env = world.environment("desk"), sessionId = env.sessionId();
  const { runId } = env.startRun(sessionId, "Check the receipts in parallel.");
  const tasks: DelegatedWorkRow[] = Array.from({ length: 24 }, (_, index) => ({
    taskId: `receipt-${index + 1}`, kind: "local_agent", description: `Check receipt ${index + 1} and its rounding rule`,
    status: "running", startedAt: `2026-09-29T10:${String(index).padStart(2, "0")}:00.000Z`, endedAt: null,
    subagentType: "Explore", toolCallId: null, error: null,
  }));
  env.emit(sessionId, "tasks.changed", { runId, tasks });
};
export const readySelector = '[aria-label="Delegated work"] button';
/** Three fixed lines keep Message and Stop inside the session even with 24 live tasks. */
export const geometry: readonly SceneGeometry[] = [
  ...idleGeometry.map((check) => check.selector === '[aria-label="Send"]' ? { ...check, selector: '[aria-label="Stop"]' } : check.selector === "[data-activity-seam]" ? { ...check, height: 3 } : check),
  { selector: '[aria-label="Delegated work"]', height: 54 },
  { selector: '[aria-label="Delegated work"] li', height: 18, unbroken: true },
  { selector: '[aria-label="Delegated work"] button', height: 18, hitTestable: true },
  { selector: '[aria-label="Message"]', visibleWithin: "[data-session-card]", hitTestable: true },
  { selector: '[aria-label="Stop"]', visibleWithin: "[data-session-card]", hitTestable: true },
];
