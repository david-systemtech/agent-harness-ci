import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import { dockGeometry, presentation as filesPresentation, script as filesScript } from "./dock-files.js";

const session = filesPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
export const script: Script = { environments: [{ ...filesScript.environments[0]!, terminals: [{
  id: "0199ee00-0000-4000-8000-000000000001", session: 0,
  output: "$ pnpm test\r\n\x1b[36mChecking receipt totals…\x1b[0m\r\n\x1b[32m12 checks passed\x1b[0m\r\n$ ",
}] }] };
export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sideColumns: { [sideColumnKey(session)]: { open: ["terminal", "browser", "documents"], shown: "terminal", hidden: false } },
};
export const readySelector = ".xterm-fg-2";
/** look.md §§8.3 and 9.3: actual terminal output, with the owning dock's measured chrome. */
export const geometry = [
  ...dockGeometry,
  { selector: '[aria-label="Terminal screen"]', paddingLeft: 8, paddingTop: 6 },
  { selector: ".xterm-rows", fontSize: 12 },
];
