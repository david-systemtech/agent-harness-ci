import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.13: the real card asking before the saved colours are replaced. */
export default setupRegionScene("appearance-default");
export const geometry = [
  ...setupGeometry,
  { selector: '[role="alertdialog"]', maxWidth: 384, visibleWithin: "body" },
];
export const readySelector = '[role="alertdialog"]';
