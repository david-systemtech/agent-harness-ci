import type { PromptKind } from "@agent-harness/contracts";
import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App, type AppProps } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import type { SceneGeometry } from "./scene-registry.js";
import { prepareWorld, startWorld } from "./world.js";

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
  denylist: {
    kind: "denylist", summary: "Read a protected key", toolName: "Read", reason: "This path matches a denylist entry.",
    input: { file_path: "/workspace/keys/private-key" }, blockedPath: "/workspace/keys/private-key",
    denylist: [{ section: "paths", entry: { id: "private-keys", pattern: "/workspace/keys/**", note: "Protected keys", enabled: true, preset: false }, matched: "/workspace/keys/private-key" }],
  },
};

/** The real window over a fresh scripted runtime on each mount, including each ladder. */
export function PromptScene({ kind, ladder }: { readonly kind: PromptKind; readonly ladder: LadderName }) {
  const [app, setApp] = useState<AppProps>();
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    queueMicrotask(() => document.getElementById("root")?.removeAttribute("data-gallery-ready"));
    void (async () => {
      const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Check the receipts" }] }] }, { presentation: { lightOrDark: ladder } });
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
      env.startRun(sessionId, "Check the receipts and explain the result.");
      const ttlExpiresAt = new Date(prepared.clock.now().getTime() + 120_000).toISOString();
      env.openPrompt(sessionId, { ...prompts[kind], ttlExpiresAt });
      env.openPrompt(sessionId, { ...prompts[kind], summary: "A second request is waiting", ttlExpiresAt });
      await new Promise<void>((resolve) => {
        const ready = () => { if (projection.read().freshness === "live" && projection.read().parkedPrompts.length === 2) { unsubscribe(); resolve(); } };
        const unsubscribe = projection.subscribe(ready);
        ready();
      });
      if (stopped) return;
      const layout = holders.presentation.values.read().paneLayout;
      holders.presentation.set("paneLayout", showSession(layout, layout.focused, { environmentId: env.environmentId, sessionId }));
      setApp({ ...holders, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: false });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [kind, ladder]);
  useEffect(() => {
    if (app !== undefined) document.getElementById("root")?.setAttribute("data-gallery-ready", `prompt-${kind}`);
  }, [app, kind]);
  return app === undefined ? null : <App {...app} />;
}

/** look.md §10.3 and §5.1: pending buttons 28, semantic icon 14, keycaps 20, argument/plan caps. */
export const promptGeometry = (kind: PromptKind): readonly SceneGeometry[] => [
  { selector: '[aria-label="Parked prompt"] button', height: 28 },
  { selector: '[aria-label="Parked prompt"] header > svg', width: 14, height: 14 },
  { selector: '[aria-label="Parked prompt"] kbd', height: 20 },
  ...(kind === "permission" ? [{ selector: '[aria-label="Arguments"]', height: 224 }] : []),
  ...(kind === "plan" ? [{ selector: '[aria-label="Plan body"]', height: 416 }] : []),
  ...(kind === "question" ? [{ selector: '[aria-label="Parked prompt"] input[type=radio]', width: 16, height: 16 }] : []),
];
