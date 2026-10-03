import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { showSession } from "../../src/grid/layout.js";
import { prepareWorld, startWorld } from "../world.js";
import { geometry as idleGeometry } from "./composer-idle.js";

async function runningScene() {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Check the receipts" }], interruptHolds: true }] });
  const holders = await startWorld(prepared, prepared.paired);
  const env = prepared.world.environment("desk"), sessionId = env.sessionId();
  const projection = holders.runtime.projections.session(env.environmentId, sessionId);
  const stop = projection.subscribe(() => {});
  const { runId } = env.startRun(sessionId, "Check the receipt totals.");
  env.emit(sessionId, "assistant.delta", { runId, itemId: "reply", fragments: [{ kind: "text", text: "I am checking the receipt totals and the rounding rule." }] });
  await new Promise<void>((resolve) => {
    const ready = () => {
      if (projection.read().freshness === "live" && projection.read().items.some((item) => item.kind === "assistant-text")) { unsubscribe(); resolve(); }
    };
    const unsubscribe = projection.subscribe(ready);
    ready();
  });
  holders.presentation.set("paneLayout", showSession(holders.presentation.values.read().paneLayout, holders.presentation.values.read().paneLayout.focused, { environmentId: env.environmentId, sessionId }));
  return function RunningComposer({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => { holders.presentation.set("lightOrDark", ladder); }, [ladder]);
    useEffect(() => () => {
      stop();
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}

export default await runningScene();
export const geometry = idleGeometry.map((check) => check.selector === '[aria-label="Send"]' ? { ...check, selector: '[aria-label="Stop"]' } : check.selector === "[data-activity-seam]" ? { ...check, height: 3 } : check);
