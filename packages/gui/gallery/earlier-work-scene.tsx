import type { StateImportDetection, StateImportReport } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App, type AppProps } from "../src/app.js";
import { STEP_CARDS } from "../src/setup/cards.js";
import { useChecklist } from "../src/setup/checklist-window.js";
import type { SceneGeometry } from "./scene-registry.js";
import { prepareWorld, startWorld } from "./world.js";

/** setup-copy.md §5.3's earlier work: as found, after Preview, and reopened with some items from the last import failed. */
export type EarlierWorkState = "found" | "preview" | "failed";

/** What the section finds: a data folder holding a little of everything, and the terminal client's folder. Every value is invented. */
const FOUND: StateImportDetection = {
  dataFolder: { path: "/home/someone/.local/share/earlier-work", holds: { profiles: 2, banks: 1, routines: 3, instructions: 4, skillSources: 2, connections: 1 } },
  terminalFolder: { path: "/home/someone/.local/state/earlier-terminal" },
};

const report = (dryRun: boolean): StateImportReport => ({
  dryRun,
  carried: { accounts: 2, archived: 6, pins: 3, groups: 2, forgeAccounts: 1, keyManagerConnections: 1, banks: 1, routines: 3, instructions: 4, skillSources: dryRun ? 2 : 1, alwaysOnSkills: dryRun ? 2 : 1, drafts: 1, devSites: 2 },
  reEnter: [{ label: "Key manager Team keys: sign in again", step: "key-manager" }],
  later: [{ label: "Profile for ollama", provider: "ollama" }],
  notCarried: [{ label: "Saved server Connections", count: 2, step: "your-machines" }, { label: "Dock layouts", count: 1, step: null }],
  failed: dryRun ? [] : [
    { label: "Skill collection team-skills", message: "Connect a forge for code.example.test.", step: "forges", details: ["Repository: https://code.example.test/team/team-skills", "Folder: .", "fatal: Authentication failed"] },
    { label: 'Always-on Skill "review" (Claude profile "Work")', message: "Skill review is missing.", step: "skills" },
    { label: "Desktop Routines", message: "agent-harness could not read this part of your earlier work.", details: ["The desktop routine list is not JSON."] },
  ],
  clientLocal: { mode: "dark", fontSize: 15, conversationWidth: "wide" },
});

const OpenCarryOver = () => {
  const { choose } = useChecklist();
  useEffect(() => choose("carry-over"), [choose]);
  return null;
};
const cards = { ...STEP_CARDS, account: OpenCarryOver };

/** The button each state presses once the section is drawn. */
const PRESS: { readonly [State in EarlierWorkState]: string | null } = { found: null, preview: "Preview", failed: null };

/** Set up open on Carry over, its earlier-work section drawn with a scripted environment; look.md §12 and §13. */
export const earlierWorkScene = (state: EarlierWorkState) => function EarlierWork({ ladder }: { readonly ladder: LadderName }) {
  const [app, setApp] = useState<AppProps>();
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    void (async () => {
      const prepared = await prepareWorld({ environments: [{
        name: "desk", reach: "local", capabilities: ["setup", "stateImport"],
        accounts: [{ label: "Work", directory: { kind: "owned", path: "/accounts/work" } }],
        stateImportFailures: state === "failed" ? report(false).failed : [],
        ...(state === "failed" && { setup: { "carry-over": {
          state: "needs-attention", reason: "3 items from your earlier work did not come over. See what to do below each one.",
          actions: ["import-again"], failing: ["carry-over.last-import"],
        } } }),
      }] }, { firstLaunch: true, presentation: { lightOrDark: ladder } });
      const desk = prepared.world.environment("desk");
      desk.wire.answer("stateImport.detect", () => ({ result: FOUND }));
      desk.wire.answer("stateImport.run", (params) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: params["dryRun"] !== true }, result: report(params["dryRun"] === true) } }));
      const world = await startWorld(prepared, prepared.paired);
      dispose = async () => {
        world.stopFollowing();
        await world.presentation.close();
        await world.runtime.close();
      };
      if (stopped) { await dispose(); return; }
      setApp({ ...world, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: prepared.macOS, stepCards: cards });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [ladder]);
  useEffect(() => {
    if (app === undefined) return;
    let began = false, pressed = false;
    const advance = () => {
      const begin = document.querySelector<HTMLButtonElement>("[data-setup-begin]");
      if (!began && begin !== null && !begin.disabled) { began = true; begin.click(); }
      const press = PRESS[state];
      if (press === null || pressed) return;
      const button = [...document.querySelectorAll<HTMLButtonElement>("[data-earlier-work] button")].find((candidate) => candidate.textContent === press && !candidate.disabled);
      if (button !== undefined) { pressed = true; button.click(); }
    };
    const observer = new MutationObserver(advance);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    advance();
    return () => observer.disconnect();
  }, [app]);
  return app === undefined ? null : <App {...app} />;
};

/** What a state's capture waits for: the section, or its report. */
export const earlierWorkReady = (state: EarlierWorkState): string => state === "found" ? "[data-earlier-work]" : state === "failed" ? "[data-earlier-work-failures]" : "[data-earlier-work-result]";

/** look.md §13.2: the rail and the footer around the Carry over card. */
export const earlierWorkGeometry: readonly SceneGeometry[] = [
  { selector: 'nav[aria-label="Set up steps"]', width: 280 },
  { selector: '[data-setup-scroll] > div', maxWidth: 620 },
  { selector: 'footer[aria-label="Step navigation"]', minimumHeight: 67 },
];
