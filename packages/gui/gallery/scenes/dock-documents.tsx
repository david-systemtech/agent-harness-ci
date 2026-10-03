import type { ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";
import { geometry as dockGeometry, presentation as filesPresentation } from "./dock-files.js";
export { script } from "./dock-files.js";

const session = filesPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sideColumns: { [sideColumnKey(session)]: { open: ["files", "diff", "documents", "tasks"], shown: "documents", hidden: false } },
};
export const arrange = (world: ScriptedWorld): void => {
  const env = world.environment("desk");
  const { runId } = env.startRun(session.sessionId, "Write the receipt notes and preview");
  env.writeFile(session.sessionId, runId, "notes.md", "# Receipt notes\n\nKeep the totals in integer cents.\n");
  env.writeFile(session.sessionId, runId, "chart.svg", '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  env.writeFile(session.sessionId, runId, "site/index.html", "<!doctype html><h1>Receipt totals</h1>");
  env.endRun(session.sessionId, runId);
};
/** look.md §9.3: document glyph wells alongside the per-session dock. */
export const geometry: readonly SceneGeometry[] = [
  ...dockGeometry,
  { selector: "[data-document-glyph]", width: 24, height: 24 },
];
