import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import { prepareWorld, startWorld } from "./world.js";

/** Real Settings over the session window, with only fake accounts and environments. */
export async function settingsScene(search: boolean) {
  const prepared = await prepareWorld({ environments: [
    { name: "desk", reach: "local", accounts: [{ label: "Personal" }, { label: "Project" }] },
    { name: "laptop", reach: "paired", accounts: [{ label: "Travel" }] },
  ] }, { presentation: { settingsRow: "accounts.accounts" } });
  const holders = await startWorld(prepared, prepared.paired);
  return function SettingsScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink("accounts.accounts"));
      if (!search) return;
      const fill = () => {
        const field = document.querySelector<HTMLInputElement>('[data-settings-dialog] input[type="search"]');
        if (field === null) return;
        observer.disconnect();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "secrets");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const observer = new MutationObserver(fill);
      observer.observe(document.body, { childList: true, subtree: true });
      fill();
      return () => observer.disconnect();
    }, [ladder]);
    useEffect(() => () => {
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}

/** look.md §12.1–12.2, at the gallery's 1400×900 viewport. */
export const settingsGeometry = [
  { selector: "[data-settings-dialog]", width: 1000, height: 660 },
  { selector: 'nav[aria-label="Settings rows"]', width: 208 },
  { selector: 'input[aria-label="Search settings"]', height: 32 },
  { selector: '[aria-label="Close Settings"]', width: 24, height: 24 },
  { selector: "[data-settings-pane]", width: 792 },
  { selector: 'nav[aria-label="Settings rows"] button svg', width: 16, height: 16 },
];
