import type { SettingsRowId } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App, type AppProps } from "../src/app.js";
import { prepareWorld, startWorld } from "./world.js";

/** Fresh real window per capture, over invented environment and tool readings. */
export function appearanceScene(row: SettingsRowId, selector: string) {
  return function AppearanceScene({ ladder }: { readonly ladder: LadderName }) {
    const [app, setApp] = useState<AppProps>();
    const [ready, setReady] = useState(false);
    useEffect(() => {
      let stopped = false;
      let dispose: (() => Promise<void>) | undefined;
      void (async () => {
        const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", capabilities: ["managedTools"], keyManagers: { tools: [
          { tool: "bao", minimum: "2.1.1", status: "not-installed", action: "install" },
          { tool: "gh", version: "2.63.2", latest: "2.63.2", minimum: "2.40.0", method: "homebrew", status: "current", action: "update" },
        ] } }] }, { presentation: { lightOrDark: ladder, settingsRow: row } });
        const world = await startWorld(prepared, prepared.paired);
        dispose = async () => {
          world.stopFollowing();
          await world.presentation.close();
          await world.runtime.close();
        };
        if (stopped) { await dispose(); return; }
        setApp({ ...world, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: false });
      })();
      return () => { stopped = true; void dispose?.(); };
    }, [ladder]);
    useEffect(() => {
      if (app === undefined) return;
      // Dispatch through the window's normal settings key; the saved row chooses the pane.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }));
      let stopped = false;
      const check = () => {
        if (document.querySelector(selector) === null) return;
        observer.disconnect();
        void (document.fonts?.ready ?? Promise.resolve()).then(() => { if (!stopped) setReady(true); });
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      check();
      return () => { stopped = true; observer.disconnect(); };
    }, [app]);
    return <>{app !== undefined && <App {...app} />}{ready && <span hidden data-appearance-ready={row} />}</>;
  };
}
