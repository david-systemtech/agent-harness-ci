import { CATALOGUE, CATALOGUE_SEED_INSTRUCTION_ID, type BankJoinPreview, type CarryOverInventory, type ContainmentReport, type ResultOf, type StepId, type StepResult } from "@agent-harness/contracts";
import type { EnvironmentHandle, ScriptedSetup } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { JoinPreview } from "../src/banks/join-bank.js";
import { STEP_CARDS } from "../src/setup/cards.js";
import type { StepCardProps } from "../src/setup/cards.js";
import { useChecklist } from "../src/setup/checklist-window.js";
import { MintedSessionCard } from "../src/setup/minted-session-card.js";
import { StepStatus } from "../src/setup/step-status.js";
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

/** A step's status at the head of its card (setup-copy.md §3; #1840): done, needing a fix with Details open, a check that could not run, and the environment out of reach. */
type StatusRegion = "status-done" | "status-fix" | "status-could-not-check" | "status-unreachable";

type SetupRegion = StepId | "bank-preview" | "authoring" | "close-confirmation" | "sign-in" | "host-updater" | "rail-states" | "instructions-unread" | "permissions-sandbox" | StatusRegion;

const isStatus = (kind: SetupRegion): kind is StatusRegion => kind.startsWith("status-");

/** setup-copy.md §5.4: a container no host updater has polled, its line offering How to set it up (#1883). */
const NEVER_POLLED: Partial<StepResult> = {
  state: "needs-attention", reason: "This container is not kept up to date yet. Set up the updater on the host computer.",
  failing: ["your-machines.host-updater"], actions: ["how-to-set-up", "check-again"],
};

/** setup-copy.md §5.10: the block could not read the forges and notebooks parts, so the line names their steps (#1856). */
const UNREAD_PARTS: Partial<StepResult> = {
  state: "needs-attention", reason: "agent-harness could not read part of this computer's setup: Forges, Memory bank.",
  failing: ["instructions.orientation-renders"], actions: ["check-again"], details: ["Unread sections of the orientation block: forges, banks"],
};

/** setup-copy.md §5.12: the sandbox chosen does not work here, so the line offers Turn the sandbox off and How to fix it (#1858). */
const SANDBOX_UNAVAILABLE: Partial<StepResult> = {
  state: "needs-attention", reason: "The sandbox you chose does not work on this computer yet.", failing: ["permissions.containment"], actions: ["turn-sandbox-off"],
  details: ["permissions.containment.default: workspace", "Probe: bubblewrap is not installed: bwrap is not on the PATH. Install the bubblewrap package.", "Cause: binary_missing"],
};

/** What the probe found for that scene: bubblewrap missing, so neither project-folder level works. */
const NO_BUBBLEWRAP: Partial<ContainmentReport> = {
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    { level: "workspace", available: false, reason: "bubblewrap is not installed: bwrap is not on the PATH. Install the bubblewrap package.", cause: "binary_missing" },
    { level: "workspace-no-network", available: false, reason: "bubblewrap is not installed: bwrap is not on the PATH. Install the bubblewrap package.", cause: "binary_missing" },
  ],
  mechanism: null,
};

/** The Instructions card's world: About my setup seeded and one suggestion ticked, and the block a new run is handed (#1856). */
const scriptInstructions = (desk: EnvironmentHandle, unreadRegistries: readonly string[]) => {
  const text = "## This computer\n\nForges, key managers and notebooks are listed here for every run.";
  const owned = CATALOGUE.instructions.entries.filter((entry) => entry.id === CATALOGUE_SEED_INSTRUCTION_ID || entry.id === "coding.fresh-checkout");
  const listed: ResultOf<"instructions.list"> = {
    orientation: { enabled: true, text, unreadRegistries: [...unreadRegistries], accounts: [] },
    instructions: owned.map((entry, index) => ({
      id: `0199dd00-0000-4000-8000-00000000008${index}`, title: entry.title, body: entry.text, origin: { catalogueId: entry.id, version: entry.version },
      scope: "all", enabled: true, position: String.fromCharCode(109 + index), newerVersion: null, accounts: [],
    })),
    dismissed: [],
  };
  desk.wire.answer("instructions.list", () => ({ result: listed }));
  desk.wire.answer("workspaces.browse", () => ({ result: { path: "/home/project", parent: "/home", directories: [], truncated: false } }));
  desk.wire.answer("instructions.preview", () => ({ result: {
    parts: [{ layer: "user", id: "orientation", title: "Orientation", text }], text,
    manifest: { channel: "system-prompt-append", layers: [], alwaysOn: [], skillSetFingerprint: null, unreadRegistries: [...unreadRegistries], leftOut: [] },
  } }));
};

/** The Skills step's result in each status scene, drawn by the step's status alone; the rest check as the environment's start did. */
const STATUS_RESULTS: { readonly [Kind in StatusRegion]?: Partial<StepResult> } = {
  "status-done": { reason: "Your skills are ready.", details: ["Collections: team-skills, house-skills"] },
  "status-fix": {
    state: "needs-attention", reason: "team-skills could not update. Choose Update now.", failing: ["skills.sources-synced"], actions: ["pull-now", "check-again"],
    targets: [{ action: "pull-now", kind: "skill-source", id: "0f8fad5b-d9cb-469f-a165-70867728950e", label: "team-skills" }],
    details: ["team-skills: git fetch exited with 128", "team-skills: could not resolve host git.example.test"],
  },
};

/**
 * setup-copy.md §4.4: the rail with every state a computer's results give at once, Done, Needs a fix, Not set up,
 * Checking and Not available (a step its version does not have), the last one shown (#1839).
 */
const RAIL_STATES: ScriptedSetup = {
  "carry-over": { state: "needs-attention", reason: "2 chats could not be read. Choose Check again." },
  "your-machines": { state: "skipped", reason: "Only on this computer." },
  forges: { state: "pending", reason: "Checking…" },
  "key-manager": null,
};

/** A provider's authorize link at its real length, which once printed over eight lines (#1690); every value is invented. */
export const SIGN_IN_URL = "https://provider.example.test/oauth/authorize?code=true&client_id=client-for-gallery&response_type=code"
  + "&redirect_uri=https%3A%2F%2Fprovider.example.test%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions"
  + "&code_challenge=challenge-for-the-gallery-sign-in-dialog-only&code_challenge_method=S256&state=state-for-the-gallery-sign-in-dialog-only";

/** Full checklist, real cards and a frozen scripted environment; look.md §12 and §13. */
async function prepareRegion(kind: SetupRegion) {
  const target: StepId = kind === "bank-preview" || kind === "authoring" ? "memory-bank" : kind === "close-confirmation" || kind === "sign-in" ? "account" : kind === "host-updater" ? "your-machines" : kind === "rail-states" ? "key-manager" : kind === "instructions-unread" ? "instructions" : kind === "permissions-sandbox" ? "permissions" : isStatus(kind) ? "skills" : kind;
  const status = isStatus(kind) ? STATUS_RESULTS[kind] : undefined;
  const prepared = await prepareWorld({ environments: [{
    name: "desk", reach: "local", capabilities: ["setup", "banks", "browser", "workspaceChecks"],
    accounts: kind === "account" || kind === "close-confirmation" ? [] : kind === "sign-in"
      ? [{ label: "Project", directory: { kind: "owned", path: "/accounts/project" }, status: { state: "expired", checkedAt: null, detail: null } }]
      : [{ label: "Project", directory: { kind: "adopted", path: "/accounts/project" } }],
    sessions: kind === "authoring" ? [{ title: "Set up: Memory bank", tags: ["setup", "memory-bank"] }] : [],
    ...(kind === "host-updater" && { setup: { "your-machines": NEVER_POLLED } }),
    ...(kind === "rail-states" && { setup: RAIL_STATES }),
    ...(kind === "instructions-unread" && { setup: { instructions: UNREAD_PARTS } }),
    ...(kind === "permissions-sandbox" && { setup: { permissions: SANDBOX_UNAVAILABLE }, containment: NO_BUBBLEWRAP, settings: { "permissions.containment.default": "workspace" } }),
    ...(status !== undefined && { setup: { skills: status } }),
  }] }, { firstLaunch: true });
  const desk = prepared.world.environment("desk");
  if (target === "instructions") scriptInstructions(desk, kind === "instructions-unread" ? ["forges", "banks"] : []);
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
  if (kind === "status-could-not-check") desk.refuseSetupChecks({ code: "internal", message: "The step registry could not load.", data: {} });
  const sessionId = kind === "authoring" ? desk.sessionId() : undefined;
  if (sessionId !== undefined) {
    const { runId } = desk.startRun(sessionId, "Describe the project memory bank.");
    desk.emit(sessionId, "assistant.text", { runId, itemId: "authoring-reply", text: "I will keep project agreements and decisions in BANK.md. Tell me which facts the team should retain.", aborted: false });
    desk.openPrompt(sessionId, authoringQuestions);
  }
  const OpenStep = () => { const { choose } = useChecklist(); useEffect(() => choose(target), [choose]); return null; };
  const PreviewCard = () => <JoinPreview preview={joinPreview} />;
  const AuthoringCard = (props: StepCardProps) => <MintedSessionCard {...props} {...(sessionId !== undefined && { sessionId })} artefact={{ kind: "folder", path: "/banks/project-memory" }} />;
  const cards = { ...STEP_CARDS, ...(target !== "account" && { account: OpenStep }), ...(kind === "bank-preview" ? { "memory-bank": PreviewCard } : kind === "authoring" ? { "memory-bank": AuthoringCard } : {}), ...(isStatus(kind) && { skills: StepStatus }) };
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
      let began = false, finished = false, signed = false;
      const advance = () => {
        const begin = document.querySelector<HTMLButtonElement>("[data-setup-begin]");
        if (!began && begin !== null && !begin.disabled) { began = true; begin.click(); }
        if (kind === "close-confirmation" && !finished) {
          const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Set up"]');
          // By mouse, as #1694 saw it: the dialog then opens with no hint over its description.
          if (close !== null) { finished = true; close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); close.click(); }
        }
        if (kind === "sign-in") {
          // Set up's Account step opens the sign-in dialog; the provider answers once the card follows the started sign-in.
          const again = [...document.querySelectorAll<HTMLButtonElement>("[data-setup-scroll] button")].find((button) => button.textContent === "Sign in again");
          if (!finished && again !== undefined) { finished = true; again.click(); }
          if (!signed && document.querySelector('[role="dialog"] section[aria-label="Terminal fallback"]') !== null) {
            signed = true;
            scene.prepared.world.environment("desk").signIn("awaiting-code", { url: SIGN_IN_URL });
          }
          return;
        }
        if (kind === "status-fix" && !finished) {
          const details = [...document.querySelectorAll<HTMLButtonElement>("[data-step-status] [data-notice-tone] button")].find((button) => button.textContent === "Details");
          if (details !== undefined) { finished = true; details.click(); }
          return;
        }
        if (kind === "status-unreachable" && !finished && document.querySelector("[data-step-status]") !== null) {
          finished = true;
          scene.prepared.world.environment("desk").server.drop();
          return;
        }
        if (kind === "host-updater" || kind === "permissions-sandbox") {
          const label = kind === "host-updater" ? "How to set it up" : "How to fix it";
          const how = [...document.querySelectorAll<HTMLButtonElement>("[data-setup-scroll] button")].find((button) => button.textContent === label);
          if (!finished && how !== undefined) { finished = true; how.click(); }
          return;
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
