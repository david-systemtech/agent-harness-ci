import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import { settingsGeometry } from "./settings-scene.js";
import type { SceneViewport } from "./scene-registry.js";
import { prepareWorld, startWorld } from "./world.js";

/** Real access panes in Settings, with invented connection and forge facts. */
export async function accessScene(row: "access.key-managers" | "access.forges") {
  const prepared = await prepareWorld({ environments: [{
    name: "desk", reach: "local", capabilities: ["keyManagers", "forge"],
    keyManagers: { connections: [{ label: "Project keys", address: "https://keys.example.test", policies: [], ticks: [], basePath: "projects/keys" }] },
    forges: { accounts: [{ origin: "https://git.example.test", kind: "forgejo", identity: { login: "builder", userId: "42" } }] },
  }] }, { presentation: { settingsRow: row } });
  const holders = await startWorld(prepared, prepared.paired);
  return function AccessScene({ ladder }: { readonly ladder: LadderName }) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const check = () => {
        if (document.querySelector("[data-settings-dialog] [data-access-card] dl") === null) return;
        setReady(true);
        observer.disconnect();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      check();
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink(row));
    }, [ladder]);
    useEffect(() => () => {
      holders.stopFollowing();
      void holders.presentation.close();
      void holders.runtime.close();
    }, []);
    return <><App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />{ready && <span hidden data-access-scene-ready />}</>;
  };
}

/** look.md §12.2–12.3 and §4: Settings cap, group inset and compact verbs. */
export const accessGeometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: "[data-access-pane]", width: Math.min(viewport.width >= 1280 ? 1440 : 1000, viewport.width - 48) - 256 },
  { selector: "[data-access-card]", paddingLeft: 12, paddingTop: 12 },
  { selector: "[data-access-card] button", height: 28 },
  { selector: "[data-access-card] header > svg", width: 16, height: 16 },
  { selector: "[data-access-card] dl", fontSize: 12 },
];
