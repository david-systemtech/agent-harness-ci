import { startInstallSurface } from "../../src/web/install.js";
import { activate as revealDecision } from "./phone-gallery-permission.js";
export { platform, script, route, arrangeWeb, geometry } from "./phone-gallery-permission.js";

// Include the production installation footer as well as the real prompt notice and grant line.
export const activate = () => {
  const stopInstall = startInstallSurface();
  const stopReveal = revealDecision();
  return () => { stopReveal(); stopInstall(); };
};
export const readySelector = '[data-web-client]:has([data-install-disclosure]) [aria-label="Allow once"]';
