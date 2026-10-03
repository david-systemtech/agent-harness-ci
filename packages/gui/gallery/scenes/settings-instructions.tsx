import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { ResultOf } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../../src/app.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";
import { prepareWorld, startWorld } from "../world.js";

const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }] }] });
const instructions: ResultOf<"instructions.list"> = {
  orientation: { enabled: true, text: "## This environment\n\nYour connected tools and memory banks are available to each run.", unreadRegistries: [], accounts: [] },
  // eslint-disable-next-line agent-harness/no-client-organisation-state -- The scripted environment supplies an owned instruction, not client state.
  instructions: [{ id: "0199dd00-0000-4000-8000-000000000076", title: "Review habits", body: "## Before a change\n\nRead the **tests** and the surrounding code.\n\n- Check the behaviour\n- Keep the change focused\n\n> Explain the decision.", origin: null, scope: "all", enabled: true, position: "m", newerVersion: null, accounts: [] }],
  dismissed: [],
};
prepared.world.environment("desk").wire.answer("instructions.list", () => ({ result: instructions }));
const world = await startWorld(prepared, prepared.paired);
export default function InstructionsScene({ ladder }: { readonly ladder: LadderName }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    world.presentation.set("lightOrDark", ladder);
    prepared.shell.openDeepLink(settingsDeepLink("knowledge.instructions"));
    let opened = false;
    const edit = () => {
      if (document.querySelector('[aria-label="Edit Review habits"] [role="toolbar"]') !== null) {
        observer.disconnect();
        setReady(true);
        return;
      }
      if (opened) return;
      const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Review habits"] button')].find((button) => button.textContent?.trim() === "Edit");
      if (button === undefined) return;
      opened = true;
      button.click();
    };
    const observer = new MutationObserver(edit);
    observer.observe(document.body, { childList: true, subtree: true });
    edit();
    return () => observer.disconnect();
  }, [ladder]);
  useEffect(() => () => { world.stopFollowing(); void world.presentation.close(); void world.runtime.close(); }, []);
  return <><App {...world} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />{ready && <span hidden data-instructions-scene-ready="true" />}</>;
}
export const readySelector = '[data-instructions-scene-ready="true"]';
/** look.md §12.1–12.3 and §8.3: bounded Settings, 128px writing floor and 12/10 inset. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: '[aria-label="Markdown body"]', minimumHeight: 128, paddingLeft: 12, paddingTop: 10 },
  { selector: '[aria-label="Markdown formatting"] button', width: 28, height: 28 },
];
