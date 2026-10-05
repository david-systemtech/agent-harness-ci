import { SCOPES } from "@agent-harness/contracts";
import type { SceneModule } from "./scene-registry.js";
import { script as sourceScript, route, safeAreas } from "./phone-frame-scene.js";

const phoneScript = sourceScript!;

/** Both released pairing choices open the real header menu, without a desktop shell. */
export const phoneMoreScene = (fullGrant: boolean): SceneModule => ({
  platform: "web",
  script: fullGrant ? { environments: phoneScript.environments.map(env => ({ ...env, scopes: SCOPES, hello: { ceiling: "bypassPermissions" } })) } : phoneScript,
  route,
  activate: () => {
    const stopInsets = safeAreas()();
    const open = () => {
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More"]');
      if (!trigger || !document.querySelector('[aria-label="Message"]')) return;
      observer.disconnect();
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" }));
    };
    const observer = new MutationObserver(open);
    observer.observe(document.body, { subtree: true, childList: true });
    open();
    return () => { observer.disconnect(); stopInsets(); };
  },
  readySelector: '.phone-frame-menu [aria-label="Terminal"]',
  geometry: [
    { selector: '.phone-frame-menu [role="menuitem"]', minimumWidth: 44, minimumHeight: 44 },
    { selector: '.phone-frame-menu [role="menuitem"] > span', contentFits: true },
    { selector: '.phone-frame-menu kbd', width: 0, height: 0 },
  ],
});
