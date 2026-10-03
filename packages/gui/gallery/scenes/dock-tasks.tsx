import type { DelegatedWorkRow } from "@agent-harness/contracts";
import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";
import { geometry as dockGeometry, presentation as filesPresentation, script as filesScript } from "./dock-files.js";

const session = filesPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
export const script: Script = { environments: filesScript.environments.map((env) => ({
  ...env, provider: { subagentTranscripts: true },
  subagentTranscripts: { "call-running": [{ type: "assistant", uuid: "reply", message: { role: "assistant", content: "The parser is in src/parser.ts." } }] },
})) };
export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sideColumns: { [sideColumnKey(session)]: { open: ["files", "diff", "documents", "tasks"], shown: "tasks", hidden: false } },
};
export const arrange = (world: ScriptedWorld): void => {
  const env = world.environment("desk");
  const { runId } = env.startRun(session.sessionId, "Survey the parser");
  const descriptions = ["Find the parser", "Waiting for a slot", "Waiting for an answer", "Checked the fixtures", "Read the missing file", "Stopped the survey"];
  const statuses = ["running", "pending", "paused", "completed", "failed", "stopped"] as const;
  const tasks: DelegatedWorkRow[] = statuses.map((status, index) => ({
    taskId: status, kind: "local_agent", description: descriptions[index] ?? status, status,
    startedAt: "2026-09-23T23:59:00.000Z", endedAt: index < 3 ? null : "2026-09-24T00:00:00.000Z",
    subagentType: "Explore", toolCallId: `call-${status}`, error: status === "failed" ? "The file was not found." : null,
  }));
  env.emit(session.sessionId, "tasks.changed", { runId, tasks });
};
/** look.md §9.3: the status glyphs are 12px; cards use x 8/y 6 and live stronger edges. */
export const geometry: readonly SceneGeometry[] = [
  ...dockGeometry,
  { selector: "[data-task-status] svg", width: 12, height: 12 },
];
