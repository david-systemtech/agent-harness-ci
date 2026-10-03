import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import { prepareWorld, startWorld } from "./world.js";
import type { SceneViewport } from "./scene-registry.js";

export type DialogScene = "pairing" | "restore" | "run-info" | "hand-off";

/** Real window dialogs on deterministic, invented accounts and sessions. */
export async function dialogScene(kind: DialogScene) {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [
    { id: "account-1", label: "work", identity: { provider: "claude", email: "agent@work.test", organisation: null } },
    { id: "account-2", label: "spare", identity: { provider: "claude", email: "agent@home.test", organisation: null } },
  ], sessions: [{ title: "Check the receipts", accountId: "account-1", model: "claude-opus-4" }],
  recommendation: { message: "Work is out of capacity. Spare has room.", accountId: "account-2", reason: "limit-reached", binding: "five_hour", candidates: 1, basis: "same-plan" },
  }] });
  const holders = await startWorld(prepared, prepared.paired);
  const env = prepared.world.environment("desk");
  const id = env.sessionId();
  if (kind === "run-info" || kind === "hand-off") holders.presentation.set("paneLayout", showSession(holders.presentation.values.read().paneLayout, holders.presentation.values.read().paneLayout.focused, { environmentId: env.environmentId, sessionId: id }));
  if (kind === "run-info") {
    const { runId } = env.startRun(id, "Check the receipts", [], { model: "claude-opus-4", effort: "high" });
    env.endRun(id, runId, { usage: [{ model: "claude-opus-4", inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }] });
  }
  if (kind === "restore") env.wire.answer("sessions.listDeleted", () => ({ result: { sessions: [{ ...env.summary(id), title: "Earlier receipts", deletedAt: "2026-09-30T09:00:00.000Z", purgeAt: "2026-10-30T09:00:00.000Z" }] } }));
  if (kind === "hand-off") env.setUsage([{ accountId: "account-1", identity: { provider: "claude", email: "agent@work.test", organisation: null }, windows: [{ window: "five_hour", utilisation: 1, resetsAt: "2026-10-03T14:00:00.000Z", verdict: "rejected", observedAt: "2026-10-03T09:00:00.000Z" }], readAt: "2026-10-03T09:00:00.000Z", unavailableReason: null }]);
  return function DialogWindow({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      const label = kind === "pairing" ? "Pair with an environment…" : kind === "restore" ? "Restore a deleted session…" : kind === "run-info" ? "Run info" : "Hand off…";
      let opened = false;
      const open = () => {
        if (opened) return;
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label);
        if (button === undefined) return;
        opened = true;
        observer.disconnect();
        button.click();
      };
      const observer = new MutationObserver(open);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      open();
      return () => { observer.disconnect(); holders.stopFollowing(); void holders.presentation.close(); void holders.runtime.close(); };
    }, [ladder]);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}

/** look.md §11.1: 512px facts/pairing/restore and 560px hand-off, with a 2rem viewport margin. */
export const dialogGeometry = (width: number) => ({ width: viewport }: SceneViewport) => [
  { selector: '[role="dialog"]', width: Math.min(width, viewport - 32) },
  { selector: '[role="dialog"] button[aria-label="Close dialog"]', width: 24, height: 24 },
];
