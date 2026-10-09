import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { BankRecord, StepResult } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { STEP_CARDS } from "../src/setup/cards.js";
import { useChecklist } from "../src/setup/checklist-window.js";
import type { SceneViewport } from "./scene-registry.js";
import { settingsGeometry } from "./settings-scene.js";
import { prepareWorld, startWorld } from "./world.js";

const since = "2026-10-02T00:00:00.000Z";
export const notebook = (): BankRecord => ({
  id: "0199aa00-0000-4000-8000-000000000002", name: "project-memory", kind: "personal",
  location: { kind: "local" }, checkout: "/banks/project-memory", checkoutOwnership: "managed", role: "read-write", enabled: true,
  accounts: "all", repositories: "all", defaultFor: ["project"], pins: [], mergeOverride: "none", privateCopy: false,
  credential: "forge", importedFrom: null, copiedFrom: null, createdAt: since,
  memories: 12, folders: 3, line: "Working agreements, project decisions and useful discoveries.", sharedAliases: [],
  validator: { installedVersion: 1, currentVersion: 2, needsUpdate: true },
  status: { reachable: { state: "reachable", since }, manifest: { state: "valid", since }, orientation: { missing: [], since }, owners: { unresolved: [], since }, lastSync: null, landing: { state: "ok", since } },
});
const team = (personal: BankRecord): BankRecord => ({
  ...personal, id: "0199aa00-0000-4000-8000-000000000003", name: "team-memory", kind: "team", role: "read-only", enabled: false,
  location: { kind: "remote", origin: "https://git.example.test", repository: "project/team-memory" }, defaultFor: [],
  validator: { installedVersion: 2, currentVersion: 2, needsUpdate: false },
  status: { ...personal.status, landing: { state: "awaiting-review", since, pullRequest: "https://git.example.test/project/team-memory/pulls/1" } },
});

const OpenBank = () => {
  const { choose } = useChecklist();
  useEffect(() => choose("memory-bank"), [choose]);
  return null;
};

/** How a Set up scene of the Memory bank step differs from the first visit (setup-copy.md §5.8, #1853). */
export interface BankSceneOptions {
  /** The step's result, in place of the skipped first visit's. */
  readonly result?: Partial<StepResult>;
  /** No forge account on the computer, so the ready-to-go row says No forge yet. */
  readonly noForge?: boolean;
  /** Create notebook pressed with the Name field emptied, so Enter a name. shows beside it. */
  readonly emptyName?: boolean;
}

/** Empties a React field as typing would, then presses the button named `label`. */
const pressWithEmpty = (field: HTMLInputElement, label: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  [...document.querySelectorAll<HTMLButtonElement>("[data-bank-form] button")].find((button) => button.textContent === label)?.click();
};

/** The live app and bank workflows over fake records, `listed` in place of the two notebooks (none in Set up) where given; no browser or service is launched. */
export async function bankScene(setup: boolean, listed?: (personal: BankRecord) => readonly BankRecord[], options: BankSceneOptions = {}) {
  const prepared = await prepareWorld({ environments: [{
    name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"],
    ...(setup ? { setup: { "memory-bank": { state: "skipped" as const, reason: "No notebook yet. Optional.", ...options.result } } } : {}),
    accounts: [{ id: "project", label: "Project" }], forges: { accounts: options.noForge === true ? [] : [{ origin: "https://git.example.test", kind: "forgejo", identity: { login: "member", userId: "42" } }] },
    sessions: [{ title: "Project work", repositoryIdentity: "https://git.example.test/project/workspace" }],
  }] }, { firstLaunch: setup, presentation: { settingsRow: "knowledge.banks" } });
  const desk = prepared.world.environment("desk");
  const personal = notebook();
  const shared = team(personal);
  const banks = listed?.(personal) ?? (setup ? [] : [personal, shared]);
  desk.wire.answer("banks.list", () => ({ result: { banks } }));
  const holders = await startWorld(prepared, prepared.paired);
  return function BankScene({ ladder }: { readonly ladder: LadderName }) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const check = () => {
        const selector = !setup ? "[data-settings-dialog] [data-bank-card]" : options.emptyName === true ? "[data-bank-form] [role='alert']" : listed === undefined ? "[data-bank-form] input" : "[data-bank-card]";
        const field = document.querySelector<HTMLInputElement>("[data-bank-form] input");
        if (options.emptyName === true && field !== null && field.value !== "") pressWithEmpty(field, "Create notebook");
        if (document.querySelector(selector) === null) return;
        observer.disconnect();
        setReady(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      check();
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      if (!setup) { prepared.shell.openDeepLink(settingsDeepLink("knowledge.banks")); return; }
      const begin = () => {
        const button = document.querySelector<HTMLButtonElement>("[data-setup-begin]");
        if (button === null || button.disabled) return;
        observer.disconnect();
        button.click();
      };
      const observer = new MutationObserver(begin);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      begin();
      return () => observer.disconnect();
    }, [ladder]);
    useEffect(() => () => {
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <>{ready && <span hidden data-bank-scene-ready />}<App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} stepCards={setup ? { ...STEP_CARDS, account: OpenBank } : STEP_CARDS} /></>;
  };
}

/** look.md §12.1–12.3: bounded Settings, bank cards and compact facts. */
export const bankSettingsGeometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-bank-content]", width: Math.min(viewport.width >= 1280 ? 1440 : 1000, viewport.width - 48) - 256 },
  { selector: "[data-bank-card]", width: viewport.width >= 1280 ? 541 : 720, contentFits: true },
  { selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 },
  { selector: "[data-bank-card] button[data-size='default']", height: 32 },
];

/** look.md §12.2 and §13.2: fixed rail, bounded choices and visible footer. */
export const bankSetupGeometry = [
  { selector: 'nav[aria-label="Set up steps"]', width: 280 },
  { selector: 'nav[aria-label="Set up steps"] button > span:first-child', width: 18 },
  { selector: "[data-bank-content]", maxWidth: 620 },
  { selector: "[data-bank-choices]", paddingLeft: 6, paddingTop: 6 },
  { selector: "[data-bank-form]", paddingLeft: 16, paddingTop: 16 },
  { selector: "[data-bank-form] [data-bank-field]", maxWidth: 224 },
  { selector: "[data-bank-form] input", height: 32 },
  { selector: 'footer[aria-label="Step navigation"]', height: 67 },
  { selector: 'footer[aria-label="Step navigation"] button', height: 32 },
];
