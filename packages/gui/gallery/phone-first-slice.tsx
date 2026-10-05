import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import { openPresentation } from "../src/presentation.js";
import { browserPlatform } from "../src/platform/browser-platform.js";

/** Actual web identity and capabilities, with the gallery's scripted wire; no desktop shell. */
export const phoneFirstScene = async (kind: "pairing" | "conversation" | "permission", width: number, height: number, textSize = 16) => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", capabilities: ["workspaceChecks"], accounts: [{ id: "account-1", label: "Scripted account" }], scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{ title: "Check the receipts", model: "scripted-model" }] }] });
  const platform = { ...browserPlatform(window, "0.0.0"), fetch: world.fetch, webSocket: world.webSocket, clock };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false); presentation.set("textSize", textSize);
  const env = world.environment("desk");
  const session = { environmentId: env.environmentId, sessionId: env.sessionId() };
  if (kind !== "pairing") {
    await runtime.connections.add({ link: env.wire.link });
    const run = env.startRun(session.sessionId, "Check the receipt totals and explain the result.");
    env.emit(session.sessionId, "assistant.text", { runId: run.runId, itemId: "reply", text: "The receipts agree with the **summary**.\n\n- Read each amount\n- Compare the total\n- Keep the existing rounding rule", aborted: false });
    if (kind === "permission") env.openPrompt(session.sessionId, { promptId: "phone-prompt", kind: "permission", summary: "Run the receipt-checking command", toolName: "Bash", input: { command: "printf receipts" } });
    else env.endRun(session.sessionId, run.runId);
  }
  return function PhoneFirstScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => { presentation.set("lightOrDark", ladder); }, [ladder]);
    useEffect(() => () => { void runtime.close(); void presentation.close(); }, []);
    useEffect(() => {
      if (kind !== "permission") return;
      return revealPermissionDecision();
    }, []);
    return <div data-web-gallery style={{ width, height: `min(${height}px, 100dvh)`, margin: "auto" }}><App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: kind === "pairing" ? {} : { session } }} /></div>;
  };
};


/** Open the bounded phone request; desktop cards already anchor their decisions. */
export function revealPermissionDecision(): () => void {
  const reveal = () => {
    const details = document.querySelector<HTMLButtonElement>('.phone-prompt-summary button');
    const decision = document.querySelector<HTMLElement>('[aria-label="Allow once"]');
    if (!decision) { details?.click(); return; }
    decision.dataset["permissionRevealed"] = "";
    observer.disconnect();
  };
  const observer = new MutationObserver(reveal);
  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
  reveal();
  return () => observer.disconnect();
}
