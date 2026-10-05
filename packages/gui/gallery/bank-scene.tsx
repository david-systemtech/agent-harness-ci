import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { BankRecord } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { STEP_CARDS } from "../src/setup/cards.js";
import { useChecklist } from "../src/setup/checklist-window.js";
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

/** The live app and bank workflows over fake records; no browser or service is launched. */
export async function bankScene(setup: boolean) {
  const prepared = await prepareWorld({ environments: [{
    name: "desk", reach: "local", capabilities: ["banks", "forge", "setup"],
    ...(setup ? { setup: { "memory-bank": { state: "skipped" as const, reason: "No banks attached yet." } } } : {}),
    accounts: [{ id: "project", label: "Project" }], forges: { accounts: [{ origin: "https://git.example.test", kind: "forgejo", identity: { login: "member", userId: "42" } }] },
    sessions: [{ title: "Project work", repositoryIdentity: "https://git.example.test/project/workspace" }],
  }] }, { firstLaunch: setup, presentation: { settingsRow: "knowledge.banks" } });
  const desk = prepared.world.environment("desk");
  const personal = notebook();
  const shared = team(personal);
  desk.wire.answer("banks.list", () => ({ result: { banks: setup ? [] : [personal, shared] } }));
  const holders = await startWorld(prepared, prepared.paired);
  return function BankScene({ ladder }: { readonly ladder: LadderName }) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const check = () => {
        const selector = setup ? "[data-bank-form] input" : "[data-settings-dialog] [data-bank-card]";
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
