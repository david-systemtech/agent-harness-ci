import { setupRegionScene, setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.1 (#1842): the real Account card with no account yet, and Claude Code on this computer signed in: its sign-in pre-selected. */
export default setupRegionScene("account-claude-code");
export const geometry = setupGeometry;
export const readySelector = '[role="radio"][aria-checked="true"]';
