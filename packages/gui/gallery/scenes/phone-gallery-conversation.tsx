import type { SceneModule } from "../scene-registry.js";

export const platform = "web";
export const script: SceneModule["script"] = { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: Array.from({ length: 1 }, () => ({ title: "Check the receipts" })) }] };
export const route: NonNullable<SceneModule["route"]> = world => ({ session: { environmentId: world.environment("desk").environmentId, sessionId: world.environment("desk").sessionId() } });
export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk");
  const { runId } = env.startRun(env.sessionId(), "Check the receipts and explain the total.");
  env.emit(env.sessionId(), "assistant.text", { runId, itemId: "reply", text: "The receipts agree with the **summary**.\n\n- Read each amount\n- Compare the total\n- Keep the existing rounding rule", aborted: false });
  env.endRun(env.sessionId(), runId);
};
export const readySelector = '[aria-label="Message"]';
export const geometry = [
  { selector: '[data-web-client] :is(button, input, select, textarea)', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
  { selector: '[aria-label="Send"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Message"]', visibleWithin: "[data-web-client]" },
];
