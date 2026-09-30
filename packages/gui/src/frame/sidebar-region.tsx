import { Sidebar } from "../sidebar/sidebar.js";

/** What the sidebar calls the local environment before it has ever answered (#181). */
export { THIS_MACHINE } from "../connections/words.js";

/**
 * The sidebar region (docs/specs/gui.md, "The window and the sidebar"): the
 * sidebar of every environment's sessions, beside the session pane region.
 */
export const SidebarRegion = () => <Sidebar />;
