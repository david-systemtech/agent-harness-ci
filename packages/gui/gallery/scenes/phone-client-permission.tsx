import { startInstallSurface } from "../../src/web/install.js";
import { activate as revealDecision } from "./phone-gallery-permission.js";
export { platform, script, route, arrangeWeb, geometry } from "./phone-gallery-permission.js";

// Keep the production installation lifecycle available in Settings while capturing the prompt and grant.
export const activate = () => {
  const stopInstall = startInstallSurface();
  const stopReveal = revealDecision();
  return () => { stopReveal(); stopInstall(); };
};
export const readySelector = '[data-web-client] [aria-label="Allow once"]';
