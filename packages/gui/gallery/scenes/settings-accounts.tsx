import { settingsScene, settingsGeometry } from "../settings-scene.js";
export default await settingsScene(false);
export const geometry = settingsGeometry;
export const ladders = ["light", "dark"] as const;
