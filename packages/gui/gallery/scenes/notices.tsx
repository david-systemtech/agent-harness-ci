import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { toast } from "../../src/ui/toaster.js";
import { prepareWorld, startWorld } from "../world.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionId = "0199dd00-0000-4000-8000-000000000001";
const script: Script = { environments: [{ name: "desk", reach: "local", environmentId, sessions: (() => [{ id: sessionId, title: "Review the receipts" }])() }] };
const prepared = await prepareWorld(script, {
  presentation: { paneLayout: { focused: "pane-1", rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: { environmentId, sessionId } }] }] } },
});
const holders = await startWorld(prepared, prepared.paired);
const env = prepared.world.environment("desk");
await env.wire.server.request("environment.subscribe");
env.notice("environment.updated", { fromVersion: "0.5.0", toVersion: "0.5.1" });
env.notice("environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
env.notice("routine.delivered", {
  routineId: "0199cc00-0000-4000-8000-0000000000a1", name: "Receipt check", entryId: "0199cc00-0000-4000-8000-0000000000a2", entryKind: "firing",
  sessionId, outcome: "failed", summary: "Workspace unavailable. Your draft is kept; continue when the workspace returns. Path: /work/receipts/a-deliberately-long-directory-name/another-directory/receipt-report.md", body: "Workspace unavailable.",
});
/** §11.3: dependency defaults are 4000ms and 356px; freeze duration only for capture. */
export default function NoticesScene({ ladder }: { readonly ladder: LadderName }) {
  useEffect(() => { holders.presentation.set("lightOrDark", ladder); }, [ladder]);
  useEffect(() => {
    const id = toast.success("Copied to clipboard", { duration: Infinity });
    return () => {
      toast.dismiss(id);
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    };
  }, []);
  return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
}
export const readySelector = '[data-notice-tone="error"]';
export const geometry = [
  { selector: "[data-notice-tone]", paddingLeft: 12, paddingTop: 8 },
  { selector: '[data-notice-tone] [role="status"], [data-notice-tone] [role="alert"]', fontSize: 11 },
  { selector: '[data-notice-tone] > svg', width: 16, height: 16 },
  { selector: '[data-notice-tone] button', height: 24 },
  { selector: '[data-notice-tone] button[aria-label="Dismiss"]', width: 24 },
  { selector: '[data-sonner-toast]', width: 356 },
];
