import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { openPresentation } from "../../src/presentation.js";
import { browserPlatform } from "../../src/platform/browser-platform.js";
import type { SceneViewport } from "../scene-registry.js";

/**
 * The phone's own pairing screen refusing a further HTTPS environment its
 * serving environment does not allow (#1713), at the 390 px the refusal was
 * squeezed at (#1739): the line takes the full width with Browser origins
 * below it, and no origin in it breaks inside its host name. The page's own
 * origin serves desk, as a real browser client's does, so the refusal is the
 * product's own; that origin is the capture's fixed one (`serve.ts`), so the
 * line names the same port on every run (#1763).
 */
const FURTHER = "https://second-laptop.example.test:8444/pair#K7Q2MXH4RT";

const clock = manualClock();
const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, webOrigins: { connectOrigins: [] } }] });
const desk = new URL(world.environment("desk").wire.link);
const served = (url: string) => url.replace(location.origin, desk.origin);
const browser = { ...browserPlatform(window, "0.0.0"), clock,
  fetch: (url: string, init?: Parameters<typeof world.fetch>[1]) => world.fetch(served(url), init),
  webSocket: (...[url, handlers]: Parameters<typeof world.webSocket>) => world.webSocket(url.replace(location.origin.replace(/^http/, "ws"), desk.origin.replace(/^http/, "ws")), handlers),
};
const runtime = createRuntime(browser);
await runtime.start();
const outcome = await runtime.connections.add({ address: location.origin, code: desk.hash.slice(1) });
if (outcome.status !== "paired") throw new Error("The gallery could not pair desk at the page's origin.");
const presentation = await openPresentation(browser.documents);
presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false);

export const platform = "web";

export default function PhonePairingUnlistedOrigin({ ladder }: { readonly ladder: LadderName }) {
  useEffect(() => { presentation.set("lightOrDark", ladder); }, [ladder]);
  return <div data-web-gallery style={{ width: "100vw", height: "100dvh" }}><App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform: browser, route: {} }} /></div>;
}

/** Opens the pairing screen from the phone header's More menu and sends the further environment's link, as a person pasting it would. */
export const activate = () => {
  let menu = false, opened = false, sent = false;
  const advance = () => {
    const form = document.querySelector<HTMLFormElement>('[aria-label="Pair by link"]');
    const field = form?.querySelector("input");
    if (form && field) {
      if (sent) return;
      sent = true;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, FURTHER);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      requestAnimationFrame(() => form.requestSubmit());
      return;
    }
    const pair = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Pair with an environment"]');
    if (pair && !opened) { opened = true; pair.click(); return; }
    const more = document.querySelector<HTMLButtonElement>('[aria-label="More"]');
    if (more && !menu) { menu = true; more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" })); }
  };
  const observer = new MutationObserver(advance);
  observer.observe(document.body, { childList: true, subtree: true });
  advance();
  return () => observer.disconnect();
};

export const readySelector = '[data-phone-pairing] [role="status"] [data-pairing-origin]';

const line = '[data-phone-pairing] [role="status"] > span';
export const geometry = ({ width }: SceneViewport) => [
  { selector: line, minimumWidth: width - 48, contentFits: true },
  { selector: '[data-phone-pairing] [role="status"] button', below: line, minimumHeight: 44 },
  { selector: "[data-pairing-origin]", unbroken: true },
];
