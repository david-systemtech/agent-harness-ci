import { accessScene, accessGeometry } from "../access-scene.js";
export default await accessScene("access.key-managers");
export const geometry = accessGeometry;
export const readySelector = '[data-access-scene-ready]';
