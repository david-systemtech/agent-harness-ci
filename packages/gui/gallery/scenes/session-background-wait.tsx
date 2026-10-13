import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { backgroundAgents, backgroundProcess } from "../../test/background-process.js";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000002132";
const sessions = ["0199dd00-0000-4000-8000-000000002131", "0199dd00-0000-4000-8000-000000002132"];

export const script: Script = { environments: [{
  environmentId, name: "desk", reach: "local", icon: "desktop", colour: "teal",
  sessions: sessions.map((id, index) => ({ id, title: index === 0 ? "Waiting during a turn" : "Waiting between turns", model: "fable" })),
}] };

export const presentation: Partial<PresentationValues> = {
  paneLayout: { focused: "pane-1", rows: [{ id: "row-1", height: 100, panes: sessions.map((sessionId, index) => ({ id: `pane-${index + 1}`, width: 50, session: { environmentId, sessionId } })) }] },
};

export const arrange = (world: ScriptedWorld): void => {
  const env = world.environment("desk");
  const processes = sessions.map((sessionId, index) => {
    const { runId } = env.startRun(sessionId, "Check these receipts with three background agents.");
    env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "The background agents are checking the receipts.", aborted: false });
    env.emit(sessionId, "tasks.changed", { runId, tasks: backgroundAgents });
    if (index === 1) env.endRun(sessionId, runId);
    return backgroundProcess(sessionId, index === 0 ? { state: "busy", runId } : {});
  });
  env.setProcesses(processes);
};

export const readySelector = '[data-activity="background"]';

export const geometry: readonly SceneGeometry[] = [
  { selector: '[data-pane-caption]', height: 32, visibleWithin: "[data-grid-card]" },
  { selector: '[aria-label="Run activity"]', contentFits: true, visibleWithin: "[data-grid-card]" },
  { selector: '[data-activity="background"]', height: 3, visibleWithin: "[data-grid-card]" },
  { selector: '[data-pane-caption] [aria-label="Running · waiting on background work"]', width: 6, height: 6 },
];
