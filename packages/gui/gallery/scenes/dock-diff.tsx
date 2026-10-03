import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";
import { geometry as dockGeometry, presentation as filesPresentation, script as filesScript } from "./dock-files.js";

const session = filesPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
const diff = "--- a/src/totals.ts\n+++ b/src/totals.ts\n@@ -1,2 +1,2 @@\n-const total = 2;\n+const total = 3;\n export { total };\n";
export const script: Script = { environments: filesScript.environments.map((env) => ({
  ...env,
  sessionDiff: { files: [{ path: "src/totals.ts", diff, changes: [{ runId: "0199a100-0000-4000-8000-000000000001", toolCallId: "edit-total", tool: "Edit", status: "ok" }] }] },
  workingTree: { diff: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+# Receipt notes\n+Keep the totals in integer cents.\n" },
})) };
export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sideColumns: { [sideColumnKey(session)]: { open: ["files", "diff", "documents", "tasks"], shown: "diff", hidden: false } },
};
/** look.md §§8.2/9.3: both sections use the shared 40px line-number gutters; refresh is 24px. */
export const geometry: readonly SceneGeometry[] = [
  ...dockGeometry,
  { selector: "[data-diff-gutter]", width: 40 },
  { selector: '[aria-label="Diff"] button[aria-label="Read again"]', width: 24, height: 24 },
];
