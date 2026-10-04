import type { SceneModule } from "./scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionId = "0199dd00-0000-4000-8000-000000000001";
export const platform = "web";
export const script: SceneModule["script"] = (() => ({ environments: [{ name: "desk", reach: "paired", environmentId, scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" },
  groups: [{ id: "0199ee00-0000-4000-8000-000000000001", name: "Receipt checks" }],
  sessions: [
    { id: sessionId, title: "Check a very long receipt title that must leave every active-session action reachable on a narrow phone", groupId: "0199ee00-0000-4000-8000-000000000001", tags: ["review"] },
    { title: "Next receipt" },
    { title: "Settled receipt", settledAt: "2026-09-01T00:00:00.000Z" },
    { title: "Archived receipt", archivedAt: "2026-09-01T00:00:00.000Z" },
    { title: "Snoozed receipt", snoozedUntil: "2030-01-01T00:00:00.000Z" },
  ],
}] }))();
export const route: NonNullable<SceneModule["route"]> = () => ({ session: { environmentId, sessionId } });
export const arrangeWeb: SceneModule["arrangeWeb"] = world => {
  const env = world.environment("desk");
  const { runId } = env.startRun(sessionId, "Check the receipts and keep the original rounding rule.");
  env.startRun(env.sessionId(1), "Wait for permission on the next receipt");
  env.openPrompt(env.sessionId(1), { promptId: "receipt-permission", kind: "permission", summary: "Check the next receipt", toolName: "Bash", input: { command: "printf receipts" } });
  env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "The receipts agree with the **summary**.\n\n- Read each amount\n- Compare the total\n- Keep the existing rounding rule", aborted: false });
};

/** Nonzero inset fixtures exercise the same CSS variables that default to the OS safe areas. */
export const safeAreas = (drawer = false) => () => {
  const root = document.documentElement;
  for (const [edge, value] of [["top", 20], ["right", 8], ["bottom", 16], ["left", 8]] as const) root.style.setProperty(`--phone-frame-safe-${edge}`, `${value}px`);
  const observer = new MutationObserver(() => {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Show sessions"]');
    if (drawer && trigger && document.querySelector('[aria-label="Message"]')) { observer.disconnect(); trigger.click(); }
  });
  if (drawer) observer.observe(document.body, { subtree: true, childList: true });
  return () => { observer.disconnect(); for (const edge of ["top", "right", "bottom", "left"]) root.style.removeProperty(`--phone-frame-safe-${edge}`); };
};

export const headerGeometry = [
  { selector: '[data-window-header] button', minimumWidth: 44, minimumHeight: 44, visibleWithin: '[data-web-client]' },

  { selector: '[data-web-client]', paddingTop: 20, paddingLeft: 8 },
];
