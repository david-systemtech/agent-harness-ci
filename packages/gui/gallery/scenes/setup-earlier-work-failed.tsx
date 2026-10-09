import { earlierWorkGeometry, earlierWorkReady, earlierWorkScene } from "../earlier-work-scene.js";

/** setup-copy.md §5.3: the earlier-work section reopened with three items from the last import failed, each with its own fix. */
export default earlierWorkScene("failed");
export const readySelector = earlierWorkReady("failed");
export const geometry = earlierWorkGeometry;
