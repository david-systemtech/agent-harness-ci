import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import { prepareWorld, startWorld } from "./world.js";

/** look.md §15: this product's queue, steering, rewind, fork and workspace check rows. */
export async function productScene(kind: "queue" | "steering" | "history" | "stopping") {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"],
    queue: kind === "steering" ? "provider" : "environment", provider: { providerQueue: true, steering: true }, interruptHolds: true,
    sessions: [{ title: "Check the receipts", workspace: { kind: "directory", path: "/projects/receipts" } }],
  }] });
  const holders = await startWorld(prepared, prepared.paired);
  const env = prepared.world.environment("desk"), sessionId = env.sessionId();
  const projection = holders.runtime.projections.session(env.environmentId, sessionId);
  const stop = projection.subscribe(() => {});
  const { runId } = env.startRun(sessionId, "Compare the receipt totals.");
  env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "The recorded totals agree. I will check the rounding rule next.", aborted: false });
  if (kind === "history") {
    env.endRun(sessionId, runId);
    const second = env.startRun(sessionId, "Check the rounding rule.");
    env.emit(sessionId, "assistant.text", { runId: second.runId, itemId: "second", text: "The parser keeps integer cents.", aborted: false });
    env.endRun(sessionId, second.runId);
  } else if (kind !== "stopping") {
    env.emit(sessionId, "message.sent", { runId, messageId: "0199aa00-0000-4000-8000-000000000011", text: "Also check the summary.", attachments: [], delivery: "queued", heldBy: kind === "steering" ? "provider" : "environment", ceiling: "acceptEdits" });
  }
  await new Promise<void>((resolve) => {
    const ready = () => { if (projection.read().freshness === "live" && projection.read().items.some((item) => item.kind === "assistant-text")) { unsubscribe(); resolve(); } };
    const unsubscribe = projection.subscribe(ready);
    ready();
  });
  if (kind === "history") {
    const answer = await holders.runtime.commands.rewind(env.environmentId, sessionId, env.messageId(sessionId, "Check the rounding rule."));
    if (answer.kind !== "rewind" || !answer.answer.ok) throw new Error(`The history scene could not rewind: ${JSON.stringify(answer)}`);
    env.emit(sessionId, "session.forked", { fromSessionId: "0199aa00-0000-4000-8000-000000000012", atMessageId: null, fromProviderSessionId: null,
      history: { title: "Earlier receipts", anchor: null, runs: [], items: [{ kind: "assistant-text", sequence: 1, runId, itemId: "copied", text: "Keep each amount in integer cents.", aborted: false }] },
    });
    const check = { terminalId: "0199aa00-0000-4000-8000-000000000013", command: "pnpm test receipts.test.ts", sourceRunId: null };
    env.emit(sessionId, "checks.started", check);
    env.emit(sessionId, "checks.finished", { ...check, output: "12 checks passed", truncated: false, exitCode: 0, signal: null, timedOut: false, failure: null });
  }
  const layout = holders.presentation.values.read().paneLayout;
  holders.presentation.set("paneLayout", showSession(layout, layout.focused, { environmentId: env.environmentId, sessionId }));
  return function ProductScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      if (kind !== "stopping") return;
      let clicked = false;
      const press = () => {
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
        if (button === null || clicked) return;
        clicked = true;
        button.click();
      };
      const observer = new MutationObserver(press);
      observer.observe(document.body, { childList: true, subtree: true });
      press();
      return () => observer.disconnect();
    }, [ladder]);
    useEffect(() => () => { stop(); holders.stopFollowing(); void holders.presentation.close(); void holders.runtime.close(); }, []);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}
