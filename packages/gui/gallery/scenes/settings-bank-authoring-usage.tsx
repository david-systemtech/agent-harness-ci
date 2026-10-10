import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { FakeShell } from "@agent-harness/client-runtime/testing";
import type { SceneGeometry } from "../scene-registry.js";
import { authoringGeometry, bankAuthoringScene } from "../authoring-scene.js";

const scene = bankAuthoringScene();
const account = { id: "account-1", label: "Project", identity: { provider: "claude", email: "project@example.test", organisation: null } };
export const script: Script = { environments: scene.script!.environments.map(environment => ({
  ...environment, accounts: [account], provider: { contextReadings: true },
  settings: { "permissions.containment.default": "workspace" },
  sessions: environment.sessions!.map(session => ({ ...session, accountId: account.id, model: "fable", mode: "auto" })),
})) };
export const { presentation, activate } = scene;
export const readySelector = '[data-authoring-dialog] [aria-label="Extra usage 30%"]';
export const arrange = (world: ScriptedWorld, shell: FakeShell): void => {
  scene.arrange?.(world, shell);
  const environment = world.environment("desk");
  const sessionId = environment.sessionId();
  const runId = environment.liveRun(sessionId)!;
  environment.emit(sessionId, "context.reported", { runId, model: "fable", contextTokens: 160_000, contextWindow: 200_000 });
  environment.setUsage([{
    accountId: account.id, identity: account.identity, readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null,
    windows: ["five_hour", "seven_day", "model_scoped:fable", "extra_usage"].map((window, index) => ({
      window, utilisation: [0.42, 0.8, 0.95, 0.3][index]!, observedAt: "2026-09-24T00:00:00.000Z",
      resetsAt: "2026-09-30T00:00:00.000Z", verdict: null,
    })),
  }]);
};

/** Every whole status group, chip, reading and ring stays inside the dedicated conversation. */
export const geometry: readonly SceneGeometry[] = [
  ...authoringGeometry,
  { selector: '[data-authoring-header] h3', visibleWithin: '[data-authoring-dialog]' },
  { selector: '[data-authoring-header] [aria-label="Status line"]', visibleWithin: '[data-authoring-dialog]', contentFits: true },
  { selector: '[data-authoring-header] [aria-label="Status line"] > *, [data-authoring-header] [data-status-chip], [data-authoring-header] [aria-label="Status line"] button, [data-authoring-header] [aria-label="Status line"] svg[role="img"], [data-authoring-header] [aria-label="Usage details"] > span', visibleWithin: '[data-authoring-dialog]' },
  { selector: '[data-authoring-header] [aria-label="Usage details"] > span > span', contentFits: true, unbroken: true },
  { selector: '[data-authoring-header] svg[role="img"]', width: 24, height: 24 },
];
