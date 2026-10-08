import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000052";
const sessionIds = ["0199dd00-0000-4000-8000-000000000051", "0199dd00-0000-4000-8000-000000000052", "0199dd00-0000-4000-8000-000000000053"];
const shares = [0.2, 0.8, 0.95];
const accounts = shares.map((share, index) => ({ id: `account-${index + 1}`, label: `Plan ${Math.round(share * 100)}`, identity: { provider: "claude", email: `plan-${index + 1}@example.test`, organisation: null } }));

export const script: Script = { environments: [{
  environmentId, name: "desk", reach: "local", icon: "desktop", colour: "teal", accounts, provider: { contextReadings: true },
  settings: { "permissions.containment.default": "workspace" },
  sessions: sessionIds.map((id, index) => ({ id, title: `Usage ${Math.round((shares[index] ?? 0) * 100)}%`, accountId: `account-${index + 1}`, model: "fable", mode: index === 2 ? "bypassPermissions" : "auto" })),
}] };

export const presentation: Partial<PresentationValues> = {
  paneLayout: {
    focused: "pane-1",
    rows: sessionIds.map((sessionId, index) => ({ id: `row-${index + 1}`, height: index === 2 ? 34 : 33, panes: [{ id: `pane-${index + 1}`, width: 100, session: { environmentId, sessionId } }] })),
  },
};

export const arrange = (world: ScriptedWorld): void => {
  const env = world.environment("desk");
  env.setUsage(accounts.map((account, index) => ({
    accountId: account.id, identity: account.identity, readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null,
    windows: [
      { window: "five_hour", utilisation: shares[index] ?? 0, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null },
      { window: "model_scoped:fable", utilisation: shares[index] ?? 0, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-30T00:00:00.000Z", verdict: null },
    ],
  })));
  sessionIds.forEach((sessionId, index) => {
    const { runId } = env.startRun(sessionId, "Check the receipts", [], { model: "fable", effort: "high" });
    env.emit(sessionId, "context.reported", { runId, model: "fable", contextTokens: Math.round((shares[index] ?? 0) * 200_000), contextWindow: 200_000 });
  });
};

/** look.md §10.5: fixed chips, 24px wrappers, and whole-chip wrapping at narrower capture widths; a model's weekly bucket captioned by the model alone beside the Context ring. */
export const geometry: readonly SceneGeometry[] = [
  { selector: '[aria-label="Status line"] [data-status-chip]', height: 22 },
  ...["Account", "Model", "Mode", "Containment", "Browser"].map((name) => ({ selector: `[aria-label="Status line"] button[aria-label^="${name}:"]`, height: 22 })),
  { selector: '[aria-label="Plan usage"] svg[role="img"]', width: 24, height: 24 },
  { selector: '[aria-label="Status line"] button[aria-label="Context usage"] svg[role="img"]', width: 24, height: 24 },
].map((check) => ({ ...check, visibleWithin: "[data-grid-card]" })); // every chip and ring inside its pane: three stacked at 1024 × 768 have no room for a second line (#1865)
