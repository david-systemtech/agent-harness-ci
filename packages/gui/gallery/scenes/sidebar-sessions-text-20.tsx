/* eslint-disable agent-harness/no-client-organisation-state -- Scripted environment fixtures, not renderer-owned organisation state. */
import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionId = "0199dd00-0000-4000-8000-000000000001";
export const script: Script = { environments: [{
  name: "desk", reach: "local", environmentId,
  hello: { environmentIcon: "desktop", environmentColour: "teal" },
  accounts: [{ id: "account-for-tests", label: "Work" }],
  sessions: [
    { id: sessionId, title: "Plan sidebar", accountId: "account-for-tests", tags: ["ui"], activity: { state: "running", since: "2026-09-24T00:00:00.000Z" } },
    { title: "Review rows", accountId: "account-for-tests", tags: ["test"], parkedPromptCount: 2, activity: { state: "parked", since: "2026-09-24T00:00:00.000Z" } },
    { title: "Branch notes", accountId: "account-for-tests", workspace: { kind: "worktree", path: "/projects/notes", repository: "/projects/app", branch: "main" } },
    { title: "Pinned notes", accountId: "account-for-tests", tags: ["notes"], pinnedAt: "2026-09-24T00:00:00.000Z" },
  ],
}] };

export const presentation: Partial<PresentationValues> = {
  textSize: 20,
  paneLayout: {
    rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: { environmentId, sessionId } }] }],
    focused: "pane-1",
  },
};
export const readySelector = "[data-sidebar-details]";

/** look.md §3 and §9.2: enlarged metadata fits the fixed slots in both desktop captures. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "html", fontSize: 16 * 20 / 14 },
  { selector: "[data-sidebar-item]", height: 54 },
  { selector: "[data-sidebar-row]", height: 50 },
  { selector: "[data-sidebar-row] > span:first-child", height: 18 },
  { selector: "[data-sidebar-title]", visibleWithin: "[data-sidebar-row]" },
  { selector: "[data-sidebar-details]", height: 16 * 20 / 14, fontSize: 11 * 20 / 14, visibleWithin: "[data-sidebar-row]", contentFits: true },
  { selector: "[data-sidebar-details] > span", visibleWithin: "[data-sidebar-details]", contentFits: true },
  { selector: "[data-sidebar-details] svg", visibleWithin: "[data-sidebar-details]" },
];
