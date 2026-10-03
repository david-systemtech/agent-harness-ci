import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { sideColumnKey } from "../../src/presentation.js";
import { prepareWorld, startWorld } from "../world.js";
import { geometry as dockGeometry, presentation as filesPresentation, script } from "./dock-files.js";

const session = filesPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
const prepared = await prepareWorld(script, { presentation: {
  ...filesPresentation,
  sideColumns: { [sideColumnKey(session)]: { open: ["terminal", "browser", "documents"], shown: "documents", hidden: false } },
} });
const holders = await startWorld(prepared, prepared.paired);
const env = prepared.world.environment("desk");
const { runId } = env.startRun(session.sessionId, "Write the receipt notes.");
env.writeFile(session.sessionId, runId, "NOTES.md", "# Receipt notes\n\nKeep integer cents.\n\n- Read every receipt\n- Compare the summary\n\n```ts\nconst total = receipts.reduce((sum, receipt) => sum + receipt.cents, 0);\n```\n");
env.endRun(session.sessionId, runId);

/** Open the snapshot through the real Documents action, just as a person does. */
const DockPreviewScene = ({ ladder }: { readonly ladder: LadderName }) => {
  useEffect(() => { holders.presentation.set("lightOrDark", ladder); }, [ladder]);
  useEffect(() => {
    const open = () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('article[aria-label="NOTES.md"] button')].find((button) => button.textContent === "Preview");
      if (button === undefined) return;
      observer.disconnect();
      button.click();
    };
    const observer = new MutationObserver(open);
    observer.observe(document.body, { childList: true, subtree: true });
    open();
    return () => {
      observer.disconnect();
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    };
  }, []);
  return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
};
export default DockPreviewScene;
export const readySelector = "[data-preview-markdown] pre code";
/** look.md §§8.1 and 9.3: a real Markdown snapshot inside the owning session dock. */
export const geometry = [
  ...dockGeometry,
  { selector: "[data-preview-markdown]", maxWidth: 768 },
  { selector: "div:has(> [data-preview-markdown])", paddingLeft: 20, paddingTop: 16 },
];
