import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SettingsRowId } from "@agent-harness/contracts";
import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import type { SceneGeometry, SceneViewport } from "./scene-registry.js";
import { prepareWorld, startWorld } from "./world.js";

/** Real Settings over the session window, with only fake accounts and environments. */
export async function settingsScene(search: boolean, row: SettingsRowId = "accounts.accounts", script: Script = { environments: [
    { name: "desk", reach: "local", accounts: [{ label: "Personal" }, { label: "Project" }] },
    { name: "laptop", reach: "paired", accounts: [{ label: "Travel" }] },
  ] }, action?: string) {
  const prepared = await prepareWorld(script, { presentation: { settingsRow: row } });
  const holders = await startWorld(prepared, prepared.paired);
  return function SettingsScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink(row));
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
    useEffect(() => {
      if (action === undefined) return;
      const activate = () => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-pane] button"))
          .find((candidate) => candidate.textContent === action && !candidate.disabled);
        if (button === undefined) return;
        observer.disconnect();
        button.click();
      };
      const observer = new MutationObserver(activate);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      activate();
      return () => observer.disconnect();
    }, []);
    useEffect(() => () => {
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
  };
}

/** look.md §12.1–12.2: responsive dialog with 24px clearance on every side. */
export const settingsGeometry = ({ width, height }: SceneViewport): readonly SceneGeometry[] => {
  const dialogWidth = Math.min(width >= 1280 ? 1440 : 1000, width - 48);
  return [
    { selector: "[data-settings-dialog]", width: dialogWidth, height: Math.min(width >= 1280 ? 900 : 660, height - 48) },
    { selector: 'nav[aria-label="Settings rows"]', width: 208 },
    { selector: 'input[aria-label="Search settings"]', height: 32 },
    { selector: '[aria-label="Close Settings"]', width: 24, height: 24 },
    { selector: "[data-settings-pane]", width: dialogWidth - 208 },
    { selector: "[data-settings-pane]", contentFits: true },
    { selector: 'nav[aria-label="Settings rows"] button svg', width: 16, height: 16 },
  ];
};
