import { webModule } from "../src/web/install.js";
import { safeAreas } from "./phone-frame-scene.js";

export { platform, script, route, arrangeWeb } from "./phone-frame-scene.js";
export { geometry, readySelector } from "./scenes/phone-frame-conversation.js";
export const presentation = { settingsRow: "about.about" };

/** Home Screen capability and startup use the same detection as the served client. */
export const installConversation = (standalone: boolean) => () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "standalone");
  Object.defineProperty(navigator, "standalone", { configurable: true, value: standalone });
  const stopInstall = webModule.registration.start();
  const stopInsets = safeAreas()();
  return () => {
    stopInsets(); stopInstall();
    if (descriptor) Object.defineProperty(navigator, "standalone", descriptor);
    else delete (navigator as Navigator & { standalone?: boolean }).standalone;
  };
};
