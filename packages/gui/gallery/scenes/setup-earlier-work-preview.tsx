import { earlierWorkGeometry, earlierWorkReady, earlierWorkScene } from "../earlier-work-scene.js";

/** setup-copy.md §5.3: the earlier-work section after Preview: what would come over, nothing changed yet. */
export default earlierWorkScene("preview");
export const readySelector = earlierWorkReady("preview");
export const geometry = earlierWorkGeometry;
