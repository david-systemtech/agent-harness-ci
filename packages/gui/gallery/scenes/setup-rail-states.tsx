import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §4.4: every state on the rail as a word, and the card of a step the computer's version does not have. */
export default setupRegionScene("rail-states");
export const geometry = setupGeometry;
export const readySelector = 'nav[aria-label="Set up steps"] button[aria-current="step"][aria-label="Key manager"] [data-state-badge="unavailable"]';
