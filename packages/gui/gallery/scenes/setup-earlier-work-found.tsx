import { earlierWorkGeometry, earlierWorkReady, earlierWorkScene } from "../earlier-work-scene.js";

/** setup-copy.md §5.3: the earlier-work section as found: one line saying what is there, its folders under Details. */
export default earlierWorkScene("found");
export const readySelector = earlierWorkReady("found");
export const geometry = earlierWorkGeometry;
