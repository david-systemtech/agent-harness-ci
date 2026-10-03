/* eslint-disable agent-harness/no-client-organisation-state -- Scripted environment fixtures, not renderer-owned organisation state. */
import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneGeometry } from "../scene-registry.js";

const groupId = "0199bb00-0000-4000-8000-000000000001";
export const script: Script = { environments: [{
  name: "desk", reach: "local", hello: { environmentIcon: "desktop", environmentColour: "teal" },
  groups: [{ id: groupId, name: "Project notes" }],
  accounts: [{ id: "account-for-tests", label: "Development" }],
  sessions: [
    { title: "Plan the sidebar", groupId, accountId: "account-for-tests", model: "model-for-tests", workspace: { kind: "worktree", path: "/projects/sidebar", repository: "/projects/app", branch: "topic/sidebar" }, activity: { state: "running", since: "2026-09-24T00:00:00.000Z" }, tags: ["ui"] },
    { title: "Review the layout", groupId, parkedPromptCount: 2, activity: { state: "parked", since: "2026-09-24T00:00:00.000Z" } },
    { title: "Pinned notes", pinnedAt: "2026-09-24T00:00:00.000Z" },
    { title: "Next task" },
    { title: "Finished task", archivedAt: "2026-09-24T00:00:00.000Z" },
  ],
}] };

/** docs/specs/look.md §9.2: fixed slots, independent of the root text scale. */
export const geometry: readonly SceneGeometry[] = [
  { selector: 'nav[aria-label="Sessions"] li', height: 54 },
  { selector: 'nav[aria-label="Sessions"] h2', height: 24 },
  { selector: "[data-sidebar-row]", height: 50 },
];
