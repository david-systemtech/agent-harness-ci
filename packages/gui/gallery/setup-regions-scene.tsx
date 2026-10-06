import type { BankJoinPreview, CarryOverInventory, StepId } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { JoinPreview } from "../src/banks/join-bank.js";
import { STEP_CARDS } from "../src/setup/cards.js";
import type { StepCardProps } from "../src/setup/cards.js";
import { useChecklist } from "../src/setup/checklist-window.js";
import { MintedSessionCard } from "../src/setup/minted-session-card.js";
import { authoringQuestions } from "./authoring-scene.js";
import { prepareWorld, startWorld } from "./world.js";

export const joinPreview: BankJoinPreview = {
  name: "team-memory", kind: "team", line: "Project agreements and useful discoveries.",
  orgs: [{ path: "team", line: "Team working agreements" }],
  projects: [{ path: "team/workspace", line: "Workspace project" }],
  entities: [{ name: "Workspace", aliases: ["project"], folder: "team/workspace" }],
  orientation: ["how-we-work"], owners: ["maintainer"],
  merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] },
  rules: ["No personal facts.", "No secrets."], canRead: true, canPush: false,
};

type SetupRegion = StepId | "bank-preview" | "authoring" | "close-confirmation";

/** Full checklist, real cards and a frozen scripted environment; look.md §12 and §13. */
async function prepareRegion(kind: SetupRegion) {
  const target: StepId = kind === "bank-preview" || kind === "authoring" ? "memory-bank" : kind === "close-confirmation" ? "account" : kind;
  const prepared = await prepareWorld({ environments: [{
    name: "desk", reach: "local", capabilities: ["setup", "banks", "browser", "workspaceChecks"],
    accounts: kind === "account" || kind === "close-confirmation" ? [] : [{ label: "Project", directory: { kind: "adopted", path: "/accounts/project" } }],
    sessions: kind === "authoring" ? [{ title: "Set up: Memory bank", tags: ["setup", "memory-bank"] }] : [],
  }] }, { firstLaunch: true });
  const desk = prepared.world.environment("desk");
  desk.wire.answer("browser.status", () => ({ result: {
    listener: { state: "listening", port: 47615 }, folder: { path: "/extension/current", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false,
    headless: { allowRuns: true, availability: { available: false, reason: "No browser installed." }, liveContexts: 0 },
  } }));
  const since = prepared.clock.now().toISOString();
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes: [{ id: "0199aa00-0000-4000-8000-000000000041", name: "Project Chrome", pairedAt: since, lastConnectedAt: since, lastReportedVersion: "0.1.0", connected: true, outdated: false }] } }));
  desk.wire.answer("browser.pairing.code", () => ({ result: { code: "TEST2345", expiresAt: new Date(prepared.clock.now().getTime() + 300_000).toISOString() } }));
  desk.wire.answer("carryOver.inventory", (params) => {
    const inventory: CarryOverInventory = {
      accountId: String(params["accountId"]), sessions: { total: 24, archived: 6, missingDirectory: 2, new: 8 },
      memory: { folders: 7, repositories: 3, unmappable: [], new: 2 },
      skills: { skills: 5, commands: 2, new: 3, offered: [], invalid: 1 },
      notCarried: [{ kind: "subagent", name: "helper" }], doesNotCarry: { hooks: 2, mcpServers: 1, permissionRules: 3 },
    };
    return { result: inventory };
  });
  const holders = await startWorld(prepared, prepared.paired);
  const sessionId = kind === "authoring" ? desk.sessionId() : undefined;
  if (sessionId !== undefined) {
    const { runId } = desk.startRun(sessionId, "Describe the project memory bank.");
    desk.emit(sessionId, "assistant.text", { runId, itemId: "authoring-reply", text: "I will keep project agreements and decisions in BANK.md. Tell me which facts the team should retain.", aborted: false });
    desk.openPrompt(sessionId, authoringQuestions);
  }
  const OpenStep = () => { const { choose } = useChecklist(); useEffect(() => choose(target), [choose]); return null; };
  const PreviewCard = () => <JoinPreview preview={joinPreview} />;
  const AuthoringCard = (props: StepCardProps) => <MintedSessionCard {...props} {...(sessionId !== undefined && { sessionId })} artefact={{ kind: "folder", path: "/banks/project-memory" }} />;
  const cards = { ...STEP_CARDS, ...(target !== "account" && { account: OpenStep }), ...(kind === "bank-preview" ? { "memory-bank": PreviewCard } : kind === "authoring" ? { "memory-bank": AuthoringCard } : {}) };
  return { holders, prepared, cards };
}

export function setupRegionScene(kind: SetupRegion) {
  return function SetupRegion({ ladder }: { readonly ladder: LadderName }) {
    const [scene, setScene] = useState<Awaited<ReturnType<typeof prepareRegion>>>();
    useEffect(() => {
      let stopped = false;
      let dispose: (() => void) | undefined;
      void prepareRegion(kind).then((ready) => {
        dispose = () => { ready.holders.stopFollowing(); void ready.holders.presentation.close(); void ready.holders.runtime.close(); };
        if (stopped) { dispose(); return; }
        ready.holders.presentation.set("lightOrDark", ladder);
        setScene(ready);
      });
      return () => { stopped = true; dispose?.(); };
    }, [ladder]);
    useEffect(() => {
      if (scene === undefined) return;
      let began = false, finished = false;
      const advance = () => {
        const begin = document.querySelector<HTMLButtonElement>("[data-setup-begin]");
        if (!began && begin !== null && !begin.disabled) { began = true; begin.click(); }
        if (kind === "close-confirmation" && !finished) {
          const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Set up"]');
          // By mouse, as #1694 saw it: the dialog then opens with no hint over its description.
          if (close !== null) { finished = true; close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); close.click(); }
        }
        if (kind !== "browser" || finished) return;
        const done = document.querySelector<HTMLButtonElement>('section[aria-label="Done"] button');
        if (done !== null && !done.disabled) { finished = true; done.click(); }
      };
      const observer = new MutationObserver(advance);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      advance();
      return () => observer.disconnect();
    }, [scene]);
    return scene === undefined ? null : <App {...scene.holders} clock={scene.prepared.clock} shell={scene.prepared.shell} version={scene.prepared.version} macOS={false} stepCards={scene.cards} />;
  };
}

/** look.md §13.2: rail and footer geometry apply to all four setup cards. */
export const setupGeometry = [
  { selector: 'nav[aria-label="Set up steps"]', width: 280 },
  { selector: '[data-setup-scroll] > div', maxWidth: 620 },
  { selector: 'footer[aria-label="Step navigation"]', minimumHeight: 67 },
  { selector: 'footer[aria-label="Step navigation"] button', height: 32 },
];
