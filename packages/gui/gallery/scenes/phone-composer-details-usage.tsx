import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneModule } from "../scene-registry.js";
import { composerDetailsScene } from "../phone-composer-details-scene.js";
import { arrangeWeb as arrangeComposer, script as composerScript } from "../phone-compact-composer-scene.js";

const account = { id: "account-1", label: "Plan 95", identity: { provider: "claude", email: "plan-1@example.test", organisation: null } } as const;
const [desk] = composerScript.environments;

/** The Run settings sheet with the status line's rings at their longest captions: Context, 5-hour and a model's weekly bucket. */
export const { platform, route, activate, readySelector, geometry } = composerDetailsScene("Run settings", false, [
  { selector: '.phone-composer-sheet [aria-label="Plan usage"]', visibleWithin: ".phone-composer-sheet", contentFits: true },
  { selector: '.phone-composer-sheet button[aria-label="Context usage"]', visibleWithin: ".phone-composer-sheet", contentFits: true },
]);
export const script: Script = { environments: [{
  ...desk!, accounts: [account], provider: { contextReadings: true },
  sessions: desk!.sessions!.map(session => ({ ...session, accountId: account.id, model: "claude-opus-4" })),
}] };
export const arrangeWeb: NonNullable<SceneModule["arrangeWeb"]> = world => {
  arrangeComposer(world);
  const env = world.environment("desk");
  env.setUsage([{
    accountId: account.id, identity: account.identity, readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null,
    windows: [
      { window: "five_hour", utilisation: 0.8, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null },
      { window: "model_scoped:fable", utilisation: 0.95, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-30T00:00:00.000Z", verdict: null },
    ],
  }]);
  const { runId } = env.startRun(env.sessionId(), "Check the receipts", [], { model: "claude-opus-4", effort: "high" });
  env.emit(env.sessionId(), "context.reported", { runId, model: "claude-opus-4", contextTokens: 160_000, contextWindow: 200_000 });
};
