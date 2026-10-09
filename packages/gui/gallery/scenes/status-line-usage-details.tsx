import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const session = { environmentId: "0199cc00-0000-4000-8000-000000000055", sessionId: "0199dd00-0000-4000-8000-000000000056" };
const account = { id: "account-1", label: "Plan 42", identity: { provider: "claude", email: "plan-42@example.test", organisation: null } };

export const script: Script = { environments: [{
  environmentId: session.environmentId, name: "desk", reach: "local", icon: "desktop", colour: "teal", accounts: [account], provider: { contextReadings: true },
  settings: { "permissions.containment.default": "workspace" },
  // eslint-disable-next-line agent-harness/no-client-organisation-state -- Scripted environment fixtures supply the session summary.
  sessions: [{ id: session.sessionId, title: "Usage details", accountId: account.id, model: "fable", mode: "auto" }],
}] };

export const presentation: Partial<PresentationValues> = {
  paneLayout: { rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session }] }], focused: "pane-1" },
};

/** The clock is 2026-09-24T00:00Z: the 5-hour window resets in 1h 44m, the weekly one in four days, and the reading is 51s old. */
export const arrange = (world: ScriptedWorld): void => {
  const observedAt = "2026-09-23T23:59:09.000Z";
  const unknown = (window: string, utilisation: number | null) => ({ window, utilisation, observedAt, resetsAt: utilisation === null ? null : "2026-09-24T03:00:00.000Z", verdict: null });
  world.environment("desk").setUsage([{
    accountId: account.id, identity: account.identity, readAt: observedAt, unavailableReason: null,
    windows: [
      { window: "five_hour", utilisation: 0.42, observedAt, resetsAt: "2026-09-24T01:44:00.000Z", verdict: null },
      { window: "seven_day", utilisation: 0.18, observedAt, resetsAt: "2026-09-28T00:00:00.000Z", verdict: null },
      unknown("iguana_necktie", 0), unknown("walrus_hat", null), unknown("otter_scarf", null),
    ],
  }]);
};

/** Opens Usage details as a click does (#1951): a pointer press first, so the focused Refresh button shows no hint. */
export const activate = () => {
  let opened = false;
  const open = () => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Plan usage"] button[aria-label="Usage details"]');
    if (opened || !button || button.querySelector('svg[role="img"]') === null) return;
    opened = true;
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    button.click();
  };
  const observer = new MutationObserver(open);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  open();
  return () => observer.disconnect();
};

export const readySelector = '[role="dialog"][aria-label="Usage details"] [aria-label="Reading age"]';

/** look.md §10.5: the popover is the 288px menu surface, inside the window, its listed windows and the silent limits' one line within it. */
export const geometry: readonly SceneGeometry[] = [
  { selector: '[role="dialog"][aria-label="Usage details"]', width: 288, visibleWithin: "body", contentFits: true, tolerance: 1 },
];
