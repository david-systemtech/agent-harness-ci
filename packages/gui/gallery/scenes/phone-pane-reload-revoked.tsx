import type { ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { phonePaneScene } from "../phone-pane-scene.js";

/**
 * A reload with the Documents sheet open, on a connection another client has
 * revoked (#1741): the restored sheet takes focus, and its close button floats
 * no hint over the needs-pairing notice, which stays above the sheet.
 */
const scene = phonePaneScene("documents");
let world: ScriptedWorld | undefined;
export const { platform, script, presentation } = scene;
export const arrangeWeb = (arranged: ScriptedWorld) => {
  scene.arrangeWeb?.(arranged);
  world = arranged;
};
export const activate = () => {
  let revoked = false;
  const revoke = () => {
    if (revoked || !document.querySelector('[data-dock-sheet] [data-document-actions]')) return;
    revoked = true;
    world?.environment("desk").wire.server.bye("revoked");
  };
  const observer = new MutationObserver(revoke);
  observer.observe(document.body, { childList: true, subtree: true });
  revoke();
  return () => observer.disconnect();
};
export const readySelector = "[data-connection-blocked]";
export const geometry = [
  { selector: "[data-connection-blocked]", contentFits: true, visibleWithin: "[data-web-client]" },
  { selector: "[data-dock-sheet]", below: "[data-connection-blocked]", visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Close side sheet"]', visibleWithin: "[data-web-client]" },
];
