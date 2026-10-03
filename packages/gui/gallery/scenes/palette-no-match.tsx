import { paletteScene, paletteGeometry } from "../palette-scene.js";
/** look.md §11.3 and §16: an unmatched query keeps search and empty feedback visible. */
export default await paletteScene("no-match");
export const geometry = paletteGeometry.filter((expectation) => !['[data-measure="palette-row-icon"]', '[cmdk-list]'].includes(expectation.selector));
export const readySelector = '[cmdk-empty]';
