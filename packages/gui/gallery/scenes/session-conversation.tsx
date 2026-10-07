import type { SceneGeometry, SceneViewport } from "../scene-registry.js";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { showSession } from "../../src/grid/layout.js";
import { prepareWorld, startWorld } from "../world.js";

/** All three captures use the real App and the shared scripted world, frozen on its manual clock. */
export async function sessionScene(kind: "conversation" | "streaming" | "find") {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Check the receipts" }] }] });
  const holders = await startWorld(prepared, prepared.paired);
  const env = prepared.world.environment("desk"), sessionId = env.sessionId();
  const projection = holders.runtime.projections.session(env.environmentId, sessionId);
  const stop = projection.subscribe(() => {});
  const { runId } = env.startRun(sessionId, "Check the receipt totals and explain the result.");
  env.emit(sessionId, "assistant.thinking", { runId, itemId: "thought", text: "Compare each receipt with the summary before changing the parser.", aborted: false });
  const text = "## Receipt totals\n\nThe receipts agree with the **summary**. The parser keeps each amount in integer cents.\n\n- Read the receipts\n- Compare the summary\n- Keep the existing rounding rule\n\n```ts\nconst total = receipts.reduce((sum, receipt) => sum + receipt.cents, 0);\n```";
  if (kind === "streaming") env.emit(sessionId, "assistant.delta", { runId, itemId: "reply", fragments: [{ kind: "text", text: "The receipts agree with the summary. I am checking the rounding rule. " }] });
  else {
    env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text, aborted: false });
    env.endRun(sessionId, runId, { durationMs: 2400 });
    // A continuation the environment sent, on the run it starts: its spine label must fit the 56 px column (#1791).
    if (kind === "conversation") env.emit(sessionId, "message.sent", { runId: "0199a1ff-0000-4000-8000-000000001791", messageId: "0199aa00-0000-4000-8000-000000001791", text: "Check the receipt totals again after the update.", attachments: [], delivery: "prompt", heldBy: null, ceiling: "auto" }, { actor: { kind: "system", id: "updates" } });
  }
  await new Promise<void>((resolve) => {
    const ready = () => { if (projection.read().freshness === "live" && projection.read().items.some((item) => item.kind === "assistant-text")) { unsubscribe(); resolve(); } };
    const unsubscribe = projection.subscribe(ready);
    ready();
  });
  holders.presentation.set("paneLayout", showSession(holders.presentation.values.read().paneLayout, holders.presentation.values.read().paneLayout.focused, { environmentId: env.environmentId, sessionId }));
  holders.presentation.set("reasoningShown", false);
  return function SessionScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      if (kind !== "find") return;
      const fill = () => {
        const field = document.querySelector<HTMLInputElement>('input[aria-label="Find"]');
        if (field === null) return;
        observer.disconnect();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "receipts");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const observer = new MutationObserver(fill);
      observer.observe(document.body, { childList: true, subtree: true });
      document.querySelector<HTMLElement>('[aria-label="Transcript"]')?.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
      fill();
      return () => observer.disconnect();
    }, [ladder]);
    useEffect(() => () => {
      stop();
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}

export default await sessionScene("conversation");

/** Comfortable column: at most 920px, inside the 224px sidebar, 21px frame and 2px card border. */
export const geometry = ({ width }: SceneViewport): readonly SceneGeometry[] => [
  { selector: '[aria-label="Transcript"] > div', width: Math.min(920, width - 247) },
  { selector: '[data-measure="transcript-spine"]', width: 56, contentFits: true },
];
