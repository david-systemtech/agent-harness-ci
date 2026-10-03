import { accessSettingsScene } from "../access-settings-scene.js";
import { accessSettingsDetails, detailGeometry } from "../access-settings-details.js";
import type { SceneViewport } from "../scene-registry.js";

const detail = accessSettingsDetails.paths;
export default await accessSettingsScene(detail.row, detail);
export const readySelector = "[data-access-scene-ready]";
/** look.md §12.2–12.3: every reviewed control fits inside the scrolling body. */
export const geometry = (viewport: SceneViewport) => detailGeometry(detail, viewport);
