import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { AccountUsage, SettingsRowId } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { prepareWorld, startWorld } from "./world.js";

/** The three Accounts panes over the real Settings dialog (Accounts with the first card's Details open), with pooled fake readings; Usage's also has three unknown limits, one with a value (#1893). */
export async function accountsScene(row: SettingsRowId, openPicker = false) {
  const identity = { provider: "claude" as const, email: "reader@example.test", organisation: null };
  const prepared = await prepareWorld({ environments: [
    { name: "desk", reach: "local", accounts: [
      { label: "Personal", identity },
      { label: "Project", status: { state: "expired", checkedAt: null, detail: null } },
    ], settings: { "accounts.defaultAccount": "account-1", "accounts.defaultModelFamily": "sonnet", "accounts.defaultEffort": "high" }, models: [{ accountId: "account-1", models: [{ id: "claude-sonnet-5", family: "sonnet", label: "Claude Sonnet 5", tier: 2, efforts: ["low", "medium", "high"] }] }] },
    { name: "laptop", reach: "paired", accounts: [{ label: "Travel", identity }] },
  ] }, { presentation: { settingsRow: row } });
  const reading: AccountUsage = { accountId: "account-1", identity, windows: [
    { window: "five_hour", utilisation: 0.42, resetsAt: "2026-09-30T14:00:00.000Z", verdict: null, observedAt: "2026-09-30T10:00:00.000Z" },
    { window: "seven_day", utilisation: 0.78, resetsAt: null, verdict: null, observedAt: "2026-09-30T10:00:00.000Z" },
    ...(row === "accounts.usage" ? ["iguana_necktie", "walrus_hat", "otter_scarf"].map((window, index) => ({ window, utilisation: index === 0 ? 0 : null, resetsAt: index === 0 ? "2026-09-30T08:00:00.000Z" : null, verdict: null, observedAt: "2026-09-30T10:00:00.000Z" })) : []),
  ], readAt: "2026-09-30T10:00:00.000Z", unavailableReason: null };
  prepared.world.environment("desk").setUsage([reading, { accountId: "account-2", identity: null, windows: [], readAt: reading.readAt, unavailableReason: "Sign in again to read this account’s usage." }]);
  prepared.world.environment("laptop").setUsage([reading]);
  const holders = await startWorld(prepared, prepared.paired);
  return function AccountsScene({ ladder }: { readonly ladder: LadderName }) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink(row));
      // Settings is portalled outside the gallery root: publish readiness back inside it.
      const selector = row === "accounts.accounts" ? "[data-account-card] svg[role=img]" : row === "accounts.default-model" ? '[data-default-choice="Model family"]' : '[aria-label="Windows"] svg';
      let openedPicker = false;
      const mark = () => {
        // setup-copy.md §5.1: an account's plan readings are in its Details; the first card's is opened so its rings are captured.
        if (row === "accounts.accounts") [...document.querySelectorAll<HTMLButtonElement>("[data-account-card] button[aria-expanded=false]")].find((fold) => fold.textContent === "Details")?.click();
        const target = document.querySelector<HTMLElement>(selector);
        if (target === null) return;
        if (row === "accounts.default-model" && !target.textContent?.includes("Claude Sonnet 5")) return;
        if (openPicker) {
          if (!openedPicker) {
            openedPicker = true;
            target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          }
          if (document.querySelector("[data-default-picker]") === null) return;
        }
        setReady(true);
        observer.disconnect();
      };
      const observer = new MutationObserver(mark);
      observer.observe(document.body, { childList: true, subtree: true });
      mark();
      return () => {
        observer.disconnect();
        holders.stopFollowing();
        void holders.presentation.close();
        void holders.runtime.close();
      };
    }, [ladder]);
    return <><App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />{ready && <span hidden data-accounts-scene-ready />}</>;
  };
}
