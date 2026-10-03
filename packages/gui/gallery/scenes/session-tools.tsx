import type { SceneGeometry, SceneViewport } from "../scene-registry.js";
import type { ToolCallEntry } from "@agent-harness/client-runtime";
import { CallsRow, CallCard } from "../../src/transcript/calls.js";
import { DocumentTile } from "../../src/transcript/document-tiles.js";
import { DiffView } from "../../src/side-column/diff-view.js";

const call = (toolCallId: string, name: string, input: ToolCallEntry["input"], output: string | null, status: ToolCallEntry["status"] = "ok"): ToolCallEntry => ({
  kind: "tool-call", sequence: 1, runId: "scene-run", toolCallId, name, input, output, status,
  title: null, agentId: null, parentToolCallId: null, decision: null, update: null, durationMs: status === "running" ? null : 1234,
});
const calls = [
  call("read", "Read", { file_path: "src/totals.ts" }, "export const total = 3;"),
  call("search", "Grep", { pattern: "total", path: "src" }, "src/totals.ts:1"),
  call("command", "Bash", { command: "pnpm lint" }, "Lint passed"),
  call("edit", "Edit", { file_path: "src/totals.ts", old_string: "const total = 2;", new_string: "const total = 3;" }, "Updated src/totals.ts"),
];
const diff = "--- a/src/totals.ts\n+++ b/src/totals.ts\n@@ -1,2 +1,2 @@\n-const total = 2;\n+const total = 3;\n export { total };";

/** look.md §§8.2 and 10.2: closed/open groups, live/failure/quiet cards, bounded machine text and documents. */
const SessionToolsScene = () => <main data-scene="session-tools" className="h-screen overflow-auto bg-abyss p-4 text-sm text-ink">
  <div className="mx-auto grid max-w-[1280px] grid-cols-2 gap-4">
    <h1 className="col-span-2 text-sm font-medium">Session tools</h1>
    <section aria-label="Closed activity group"><CallsRow calls={calls} facts={{ arrived: () => false, quietMs: () => 0, workspace: null, revealed: null, verbs: false }} /></section>
    <section aria-label="Open activity group"><CallsRow calls={calls} facts={{ arrived: () => false, quietMs: () => 0, workspace: null, revealed: { toolCallId: "edit", asking: 1 }, verbs: false }} /></section>
    <CallCard call={call("running", "Bash", { command: "pnpm typecheck" }, null, "running")} quietMs={0} />
    <CallCard call={call("quiet", "Bash", { command: "pnpm build" }, null, "running")} quietMs={180_000} />
    <CallCard call={call("failed", "Read", { file_path: "missing.ts" }, "not_found: No file missing.ts in the workspace.", "error")} quietMs={0} />
    <div className="flex items-start gap-2 self-start"><DocumentTile path="site/index.html" kind="Page" preview={() => {}} /><DocumentTile path="notes.md" kind="Markdown" preview={() => {}} /><DocumentTile path="chart.svg" kind="SVG" absent="Preview is unavailable in this client." preview={() => {}} /></div>
    <section aria-label="Shared diff"><DiffView text={diff} /></section>
  </div>
</main>;

export const geometry = ({ width, height }: SceneViewport): readonly SceneGeometry[] => [
  { selector: "main[data-scene=session-tools]", width, height, tolerance: 0.1 },
  { selector: "[data-diff-gutter]", width: 40, tolerance: 0.1 },
];
export default SessionToolsScene;
