import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../src/app.js";
import type { SceneGeometry, SceneViewport } from "./scene-registry.js";
import { settingsGeometry } from "./settings-scene.js";
import { prepareWorld, startWorld } from "./world.js";

/**
 * The states of Add a device on Settings › Your machines (setup-copy.md
 * §5.5, §4.2; #1847): who a code is for, as it opens; a code made; this
 * computer reachable only from itself, its warning above the button and the
 * code made anyway saying it works only here; and Part 2's refusal when
 * nothing answers, the raw failure in Details.
 */
export type AddADeviceState = "who" | "code" | "local" | "refused";

const PART_ONE = "Connect a phone or computer to this one";
const PART_TWO = "Connect this app to another computer";

/** A part of Add a device, by its heading. */
const partOf = (title: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>("section[aria-labelledby]")).find((section) => section.querySelector(":scope > h4")?.textContent === title) ?? null;

/** What each state waits for, inside its part, before it is ready to measure. */
const READY: { readonly [State in AddADeviceState]: string } = {
  who: '[role="radiogroup"][aria-label="Who is it for?"]',
  code: '[aria-label="QR code of the pairing link"]',
  local: '[role="group"][aria-label="Pairing code"]',
  refused: "[data-pairing-refusal]",
};

export async function addADeviceScene(state: AddADeviceState) {
  const prepared = await prepareWorld({
    environments: [
      {
        name: "desk", reach: "local", icon: "desktop", colour: "teal",
        ...(state === "local" && { status: { binding: { tailnet: null, tailnetFound: null, tailscaleInstalled: false, lan: null, lanAddresses: [] } } }),
      },
      { name: "laptop", reach: "unpaired", ...(state === "refused" && { discovery: "nothing" as const }) },
    ],
  }, { presentation: { settingsRow: "environments.machines" } });
  const holders = await startWorld(prepared, prepared.paired);
  const link = prepared.world.environment("laptop").wire.link;
  return function AddADeviceScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      prepared.shell.openDeepLink(settingsDeepLink("environments.machines"));
    }, [ladder]);
    useEffect(() => {
      let acted = false;
      const act = () => {
        const part = partOf(state === "refused" ? PART_TWO : PART_ONE);
        if (part === null) return;
        if (!acted && state !== "who") {
          if (state === "refused") {
            const form = part.querySelector<HTMLFormElement>('[aria-label="Pair by link"]');
            const field = form?.querySelector("input");
            if (!form || !field) return;
            acted = true;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, link);
            field.dispatchEvent(new Event("input", { bubbles: true }));
            requestAnimationFrame(() => form.requestSubmit());
          } else {
            const button = Array.from(part.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent === "Make a pairing code" && !candidate.disabled);
            if (button === undefined) return;
            acted = true;
            button.click();
          }
        }
        const ready = part.querySelector<HTMLElement>(READY[state]);
        if (ready === null) return;
        observer.disconnect();
        requestAnimationFrame(() => {
          part.scrollIntoView({ block: "start" });
          part.setAttribute("data-add-a-device-ready", "");
        });
      };
      const observer = new MutationObserver(act);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      act();
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

export const addADeviceReady = "[data-add-a-device-ready]";

/** look.md §12: the Settings dialog, Add a device's card within the pane's width, and its 32 px buttons. */
export const addADeviceGeometry = (viewport: SceneViewport): readonly SceneGeometry[] => [
  ...settingsGeometry(viewport),
  { selector: "[data-settings-card-grid] + section", maxWidth: 768, contentFits: true },
  { selector: '[data-add-a-device-ready] button[data-variant][data-size="default"]', height: 32 },
];
