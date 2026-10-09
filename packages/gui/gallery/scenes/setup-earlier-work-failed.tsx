import { earlierWorkGeometry, earlierWorkReady, earlierWorkScene } from "../earlier-work-scene.js";

/** setup-copy.md §5.3: the earlier-work section after Bring it over with three items failed, each with its own fix. */
export default earlierWorkScene("failed");
export const readySelector = earlierWorkReady("failed");
export const geometry = earlierWorkGeometry;
