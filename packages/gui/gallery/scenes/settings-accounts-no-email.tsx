import { settingsScene, settingsGeometry } from "../settings-scene.js";

/** setup-copy.md §5.1: Settings can name a signed-in ambient account even when its email is unavailable. */
export default await settingsScene(false, "accounts.accounts", { environments: [
  { name: "desk", reach: "local", accounts: [], ambient: { present: true, signedIn: true, identity: null } },
] });
export const geometry = settingsGeometry;
export const readySelector = "[data-account-name-required]";
export const ladders = ["light", "dark"] as const;
