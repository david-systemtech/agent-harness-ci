import { setupRegionScene } from "../setup-regions-scene.js";
import { authoringGeometry } from "../authoring-scene.js";
export default setupRegionScene("authoring");
export const readySelector = '[data-authoring-dialog] [aria-label="Send answers"]';
export const geometry = authoringGeometry;
