import { accessScene, accessGeometry } from "../access-scene.js";
export default await accessScene("access.forges");
export const geometry = (viewport: Parameters<typeof accessGeometry>[0]) => [
  ...accessGeometry(viewport),
  { selector: '[aria-label="Capabilities"] [role="img"]', width: 6, height: 6 },
];
export const readySelector = '[data-access-scene-ready]';
