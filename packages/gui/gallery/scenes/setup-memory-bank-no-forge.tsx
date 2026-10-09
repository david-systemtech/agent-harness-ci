import { bankScene } from "../bank-scene.js";
/** setup-copy.md §5.8: no forge yet, the ready-to-go row says so with Go to Forges, and the notebook can still stay on this computer (#1853). */
export default await bankScene(true, undefined, { noForge: true });
export const readySelector = "[data-bank-scene-ready]";
export { bankSetupGeometry as geometry } from "../bank-scene.js";
