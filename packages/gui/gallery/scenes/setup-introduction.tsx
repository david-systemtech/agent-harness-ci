import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App, type AppProps } from "../../src/app.js";
import type { SceneGeometry } from "../scene-registry.js";
import { prepareWorld, startWorld } from "../world.js";

/** look.md §13.1: the introduction owns the first frame while startup is pending or failed. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-setup-frame]", height: 44 },
  { selector: "[data-setup-introduction]", width: 720 },
  { selector: "[data-setup-tile]", width: 44, height: 44 },
  { selector: "[data-setup-service] > div:first-child", width: 32, height: 32 },
];

export const SetupIntroductionScene = ({ ladder, failed = false }: { readonly ladder: LadderName; readonly failed?: boolean }) => {
  const [app, setApp] = useState<AppProps>();
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    queueMicrotask(() => document.getElementById("root")?.removeAttribute("data-gallery-ready"));
    void (async () => {
      const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { firstLaunch: true, presentation: { lightOrDark: ladder } });
      if (failed) prepared.shell.answer("service.status", async () => { throw new Error("Could not read service status."); });
      else prepared.shell.answer("service.start", () => new Promise<void>(() => {}));
      const world = await startWorld(prepared, prepared.paired);
      dispose = async () => { world.stopFollowing(); await world.presentation.close(); await world.runtime.close(); };
      if (stopped) { await dispose(); return; }
      setApp({ ...world, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: prepared.macOS });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [ladder, failed]);
  useEffect(() => {
    if (app === undefined) return;
    const root = document.getElementById("root");
    if (root === null) throw new Error("The introduction scene needs the gallery root.");
    const mark = () => {
      const status = root.querySelector('[data-setup-service] [role="status"]')?.textContent;
      if (status === (failed ? "The environment could not start on this machine." : "Starting the environment on this machine")) root.dataset["galleryReady"] = failed ? "setup-introduction-failed" : "setup-introduction";
    };
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    mark();
    return () => observer.disconnect();
  }, [app, failed]);
  return app === undefined ? null : <App {...app} />;
};

export default SetupIntroductionScene;
