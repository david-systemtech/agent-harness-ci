import { StoredCredentialUnavailableError } from "@agent-harness/client-runtime";
import { describeDenylistMatch, type DenylistMatch, type PromptKind } from "@agent-harness/contracts";
import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App, type AppProps } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import { PANE_CARD_UNSCROLLABLE } from "./geometry.js";
import type { SceneGeometry } from "./scene-registry.js";
import { prepareWorld, startWorld } from "./world.js";

const protectedKey: DenylistMatch = { section: "paths", entry: { id: "private-keys", pattern: "/workspace/keys/**", note: "Protected keys", enabled: true, preset: false }, matched: "/workspace/keys/private-key" };

const prompts: Readonly<Record<PromptKind, ScriptedPrompt>> = {
  permission: {
    summary: "Run the build checks", toolName: "Bash", reason: "The command needs your approval.",
    input: { command: Array.from({ length: 20 }, (_, at) => `printf 'Check ${at + 1}\\n'`).join("\n") },
  },
  question: {
    kind: "question", summary: "Which checks should run?", toolName: "AskUserQuestion", input: null,
    questions: [{ header: "Checks", question: "Which checks should run?", multiSelect: false, options: [
      { label: "Types", description: "Check the workspace types." }, { label: "Tests", description: "Run the named test files." },
    ] }],
  },
  plan: {
    kind: "plan", summary: "Check the receipts", toolName: "ExitPlanMode", input: null, mode: "plan", ceiling: "acceptEdits",
    plan: "## Check the receipts\n\n" + Array.from({ length: 32 }, (_, at) => `${at + 1}. Compare the recorded amount with the summary and explain any difference.\n`).join("\n"),
  },
  // As the environment's gate asks it: the summary and the reason both name the match as a sentence, which the card says once (#1905).
  denylist: {
    kind: "denylist", summary: `Read: ${describeDenylistMatch(protectedKey)}`, toolName: "Read", reason: describeDenylistMatch(protectedKey),
    input: { file_path: "/workspace/keys/private-key" }, denylist: [protectedKey],
  },
};

export type PromptSceneState = "pending" | "busy" | "error" | "settled";

/** The real window over a fresh scripted runtime on each mount, including each ladder. */
export function PromptScene({ kind, ladder, state = "pending", withNotices = false, short = false }: { readonly kind: PromptKind; readonly ladder: LadderName; readonly state?: PromptSceneState; readonly withNotices?: boolean; readonly short?: boolean }) {
  const [app, setApp] = useState<AppProps>();
  const [stateDrawn, setStateDrawn] = useState(false);
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    queueMicrotask(() => document.getElementById("root")?.removeAttribute("data-gallery-ready"));
    void (async () => {
      const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Check the receipts" }] }, ...(withNotices ? [{ name: "laptop", reach: "paired" as const, sessions: [] }] : [])] }, { presentation: { lightOrDark: ladder, ...(withNotices && { textSize: 20 }) } });
      const holders = await startWorld(prepared, prepared.paired);
      const env = prepared.world.environment("desk"), sessionId = env.sessionId();
      const projection = holders.runtime.projections.session(env.environmentId, sessionId);
      const stop = projection.subscribe(() => {});
      dispose = async () => {
        stop();
        holders.stopFollowing();
        await holders.presentation.close();
        await holders.runtime.close();
      };
      if (stopped) { await dispose(); return; }
      if (withNotices) {
        prepared.shell.answer("secrets.get", () => { throw new StoredCredentialUnavailableError("OS approval was unavailable."); });
        await holders.runtime.connections.retryNow(prepared.world.environment("laptop").environmentId);
        await env.wire.server.request("environment.subscribe");
        env.notice("environment.updated", { fromVersion: "0.5.0", toVersion: "0.5.1" });
      }
      const { runId } = env.startRun(sessionId, "Check the receipts and explain the result.");
      if (withNotices) env.emit(sessionId, "assistant.text", { runId, itemId: "reply", text: "Review the receipts before approving the command.\n\n".repeat(12), aborted: false });
      const ttlExpiresAt = new Date(prepared.clock.now().getTime() + 120_000).toISOString();
      const promptId = env.openPrompt(sessionId, { ...prompts[kind], ...(short && { summary: "Create a local check tag", input: { command: "git tag qa-check" } }), ttlExpiresAt });
      if (state === "pending" && !withNotices) env.openPrompt(sessionId, { ...prompts[kind], summary: "A second request is waiting", ttlExpiresAt });
      await new Promise<void>((resolve) => {
        const ready = () => { if (projection.read().freshness === "live" && projection.read().parkedPrompts.length === (state === "pending" && !withNotices ? 2 : 1)) { unsubscribe(); resolve(); } };
        const unsubscribe = projection.subscribe(ready);
        ready();
      });
      if (stopped) return;
      if (state === "settled") env.answerElsewhere(sessionId, promptId, { decision: "deny" });
      if (state === "error") env.answerElsewhere(sessionId, promptId, { decision: "allow", heard: false });
      if (state === "busy") env.wire.answer("permissions.prompts.answer", () => undefined);
      const layout = holders.presentation.values.read().paneLayout;
      holders.presentation.set("paneLayout", showSession(layout, layout.focused, { environmentId: env.environmentId, sessionId }));
      setApp({ ...holders, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: false });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [kind, ladder, state, withNotices, short]);
  useEffect(() => {
    if (app !== undefined && state === "pending") document.getElementById("root")?.setAttribute("data-gallery-ready", `prompt-${kind}`);
  }, [app, kind, state]);
  useEffect(() => {
    if (app === undefined || state === "pending") return;
    let clicked = false;
    const update = () => {
      const card = document.querySelector('[aria-label="Parked prompt"]');
      if ((state === "busy" || state === "error") && !clicked && card !== null) {
        const action = card.querySelector<HTMLButtonElement>('button[aria-label="Deny"], button[aria-label="Skip"], button[aria-label="Keep planning"]');
        if (action !== null) { clicked = true; action.click(); }
      }
      const drawn = state === "error" ? card?.querySelector('[role="status"]')?.textContent?.startsWith("Not answered:") === true
        : state === "busy" ? clicked && card === null : document.querySelector('article[aria-label="Permission"], article[aria-label="Plan"], article[aria-label="Question"]') !== null;
      if (drawn) { setStateDrawn(true); observer.disconnect(); }
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    update();
    return () => observer.disconnect();
  }, [app, state]);
  return app === undefined ? null : <><App {...app} />{stateDrawn && <span hidden data-prompt-state={state} />}</>;

}

/** look.md §10.3 and §5.1: pending buttons 28, semantic icon 14, keycaps 20, argument/plan caps. */
export const promptGeometry = (kind: PromptKind): readonly SceneGeometry[] => [
  PANE_CARD_UNSCROLLABLE,
  { selector: '[aria-label="Parked prompt"] button', height: 28 },
  { selector: '[aria-label="Parked prompt"] header > svg', width: 14, height: 14 },
  { selector: '[aria-label="Parked prompt"] kbd', height: 20, renderedOnly: true },
  ...(kind === "permission" ? [
    { selector: '[aria-label="Arguments"]', height: 224, viewport: 1400 },
    { selector: '[aria-label="Permission request"]', minimumHeight: 48, visibleWithin: '[aria-label="Parked prompt"]' },
    { selector: '[aria-label="Permission decision"]', visibleWithin: '[aria-label="Parked prompt"]' },
    { selector: '[aria-label="Permission decision"] textarea', visibleWithin: '[aria-label="Parked prompt"]', minimumHeight: 48 },
    { selector: '[aria-label="Permission decision"] button', visibleWithin: '[aria-label="Parked prompt"]' },
  ] : []),
  ...(kind === "plan" ? [
    { selector: '[aria-label="Plan body"]', maxHeight: 416, visibleWithin: '[aria-label="Parked prompt"]' },
    { selector: '[aria-label="Parked prompt"] textarea', minimumHeight: 48, visibleWithin: '[aria-label="Parked prompt"]' },
    { selector: '[aria-label="Parked prompt"] button', visibleWithin: '[aria-label="Parked prompt"]' },
    { selector: '[aria-label="Parked prompt"] label', visibleWithin: '[aria-label="Parked prompt"]' },
  ] : []),
  ...(kind === "question" ? [{ selector: '[aria-label="Parked prompt"] input[type=radio]', width: 16, height: 16 }] : []),
];

/** The short laptop window still exposes decisions, Message and Stop with both normal top banners (#2090). */
export const noticePermissionGeometry: readonly SceneGeometry[] = [
  PANE_CARD_UNSCROLLABLE,
  { selector: "html", fontSize: 16 * 20 / 14, contentFits: true },
  { selector: '[aria-label="Notifications"] li', visibleWithin: "main", contentFits: true },
  { selector: '[aria-label="Transcript"]', minimumHeight: 112, visibleWithin: '[aria-label="Session pane"]' },
  { selector: '[aria-label="Parked prompt"]', visibleWithin: '[aria-label="Session pane"]', contentFits: true },
  { selector: '[aria-label="Permission request"]', minimumHeight: 48, visibleWithin: '[aria-label="Parked prompt"]' },
  { selector: '[aria-label="Permission decision"]', visibleWithin: '[aria-label="Parked prompt"]', contentFits: true },
  { selector: '[aria-label="Permission decision"] textarea', minimumHeight: 48, visibleWithin: '[aria-label="Parked prompt"]' },
  { selector: '[aria-label="Permission decision"] button, [aria-label="Hide request"]', visibleWithin: '[aria-label="Parked prompt"]', hitTestable: true },
  { selector: "[data-composer-column]", visibleWithin: '[aria-label="Session pane"]', contentFits: true },
  { selector: '[aria-label="Message"], button[aria-label="Stop"]', visibleWithin: '[aria-label="Session pane"]', hitTestable: true },
];
