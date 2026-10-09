import { bankScene } from "../bank-scene.js";
/** setup-copy.md §5.8: Create notebook pressed with the Name field empty says Enter a name. beside it (#1853). */
export default await bankScene(true, undefined, { emptyName: true });
export const readySelector = "[data-bank-scene-ready]";
export { bankSetupGeometry as geometry } from "../bank-scene.js";
