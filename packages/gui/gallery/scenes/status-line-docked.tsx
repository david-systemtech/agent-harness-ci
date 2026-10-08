import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const session = { environmentId: "0199cc00-0000-4000-8000-000000000053", sessionId: "0199dd00-0000-4000-8000-000000000054" };
const account = { id: "account-1", label: "Plan 80", identity: { provider: "claude", email: "plan-80@example.test", organisation: null } };

export const script: Script = { environments: [{
  environmentId: session.environmentId, name: "desk", reach: "local", icon: "desktop", colour: "teal", accounts: [account], provider: { contextReadings: true },
  settings: { "permissions.containment.default": "workspace" },
  sessions: Array.from({ length: 1 }, () => ({ id: session.sessionId, title: "Usage 80%", accountId: account.id, model: "fable", mode: "auto" })),
  files: ["README.md", "package.json", "src/totals.ts", "test/totals.test.ts"],
}] };

/** A side pane docked beside the session narrows its column: at 1280 × 800 to about 640px, where #1892 saw the spend read "7.". */
export const presentation: Partial<PresentationValues> = {
  paneLayout: { rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session }] }], focused: "pane-1" },
  sideColumns: { [sideColumnKey(session)]: { open: ["files"], shown: "files", hidden: false } },
};

export const arrange = (world: ScriptedWorld): void => {
  const env = world.environment("desk");
  env.setUsage([{
    accountId: account.id, identity: account.identity, readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null,
    windows: [{ window: "five_hour", utilisation: 0.8, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null }],
  }]);
  const { runId } = env.startRun(session.sessionId, "Check the receipts", [], { model: "fable", effort: "high" });
  env.emit(session.sessionId, "context.reported", { runId, model: "fable", contextTokens: 160_000, contextWindow: 200_000 });
  env.emit(session.sessionId, "usage.reported", {
    runId, models: [{ model: "fable", inputTokens: 3000, outputTokens: 500, cacheReadTokens: 68_000, cacheWriteTokens: 1500, costUsd: 0.03, contextWindow: 200_000 }],
  });
};

/** look.md §10.5: the run's spend wraps whole onto the status line's next row, never cut to what the chips leave on the first. */
export const geometry: readonly SceneGeometry[] = [
  ...["Account", "Model", "Mode", "Containment", "Browser"].map((name) => ({ selector: `[aria-label="Status line"] button[aria-label^="${name}:"]`, height: 22 })),
  { selector: '[aria-label="Status line"] [aria-label="Run status"]', contentFits: true, tolerance: 1 },
].map((check) => ({ ...check, visibleWithin: "[data-grid-card]" }));
