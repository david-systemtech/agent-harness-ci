import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { ServiceFailureError } from "@agent-harness/client-runtime";
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

/** The service states the introduction's scenes draw (setup-copy.md §4.1), each with the status line that marks it drawn. */
export const INTRODUCTION_STATES = {
  starting: "Starting agent-harness on this computer…",
  failed: "Error: agent-harness cannot start on this computer.",
  off: "agent-harness is turned off on this computer.",
  stopped: "agent-harness is not running on this computer.",
  unavailable: "This app cannot run agent-harness itself.",
} as const;

export type IntroductionState = keyof typeof INTRODUCTION_STATES;

export const SetupIntroductionScene = ({ ladder, state = "starting" }: { readonly ladder: LadderName; readonly state?: IntroductionState }) => {
  const [app, setApp] = useState<AppProps>();
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    queueMicrotask(() => document.getElementById("root")?.removeAttribute("data-gallery-ready"));
    void (async () => {
      const prepared = await prepareWorld(
        { environments: state === "unavailable" ? [] : [{ name: "desk", reach: "local", discovery: "nothing" }] },
        { firstLaunch: true, presentation: { lightOrDark: ladder, ...(state === "off" && { runLocalEnvironment: false }) } },
      );
      if (state === "failed") prepared.shell.answer("service.start", async () => { throw new ServiceFailureError("start", "Could not start the environment on this machine: No user service manager is available."); });
      else if (state === "unavailable") Object.defineProperty(prepared.shell, "service", { value: undefined });
      else if (state === "starting") prepared.shell.answer("service.start", () => new Promise<void>(() => {}));
      const world = await startWorld(prepared, prepared.paired);
      dispose = async () => { world.stopFollowing(); await world.presentation.close(); await world.runtime.close(); };
      if (stopped) { await dispose(); return; }
      setApp({ ...world, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: prepared.macOS });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [ladder, state]);
  useEffect(() => {
    if (app === undefined) return;
    const root = document.getElementById("root");
    if (root === null) throw new Error("The introduction scene needs the gallery root.");
    const mark = () => {
      const service = root.querySelector("[data-setup-service]");
      if (service?.querySelector('[role="status"], [role="alert"]')?.textContent !== INTRODUCTION_STATES[state]) return;
      // The failed scene draws its Details open, the desktop's text and Copy details showing.
      const details = state === "failed" ? [...service.querySelectorAll("button")].find((button) => button.textContent === "Details") : undefined;
      if (details !== undefined && details.getAttribute("aria-expanded") !== "true") { details.click(); return; }
      root.dataset["galleryReady"] = state === "starting" ? "setup-introduction" : `setup-introduction-${state}`;
    };
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-expanded"] });
    mark();
    return () => observer.disconnect();
  }, [app, state]);
  return app === undefined ? null : <App {...app} />;
};

export default SetupIntroductionScene;
