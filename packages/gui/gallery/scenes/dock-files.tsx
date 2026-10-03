import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const session = { environmentId: "0199cc00-0000-4000-8000-000000000001", sessionId: "0199dd00-0000-4000-8000-000000000001" };
export const script: Script = { environments: [{
  name: "desk", reach: "local", environmentId: session.environmentId,
  sessions: Array.from({ length: 1 }, () => ({ id: session.sessionId, title: "Browse the workspace" })),
  files: ["README.md", "package.json", "logo.png", "notes.txt", "build.lock", "src/app.tsx", "src/totals.ts", "test/totals.test.ts"],
}] };
export const presentation: Partial<PresentationValues> = {
  paneLayout: { rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session }] }], focused: "pane-1" },
  sideColumns: { [sideColumnKey(session)]: { open: ["files", "diff", "documents", "tasks"], shown: "files", hidden: false } },
};
/** look.md §9.3: fixed physical dimensions in the owning session pane. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-dock-rail]", width: 40 },
  // look.md §9.3: 12/18 filename plus 4px top/bottom; 14px kind icons.
  { selector: "[data-file-row]", height: 26 },
  { selector: "[data-file-row] svg", width: 14, height: 14 },
  { selector: "[data-files-caption] button", width: 24, height: 24 },
  { selector: "section:not([hidden]) > [data-dock-header]", height: 30 },
  { selector: '[role="tab"]', width: 28, height: 28 },
  { selector: '[role="tab"] svg', width: 24, height: 24 },
  { selector: '[role="tablist"] button[aria-label^="Close "]', width: 14, height: 14 },
  { selector: '[role="tablist"] button[aria-label^="Close "] svg', width: 10, height: 10 },
  { selector: '[aria-label="New terminal"]', width: 28, height: 28 },
];
