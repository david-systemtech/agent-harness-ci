import { sideColumnKey, type PresentationValues } from "../../src/presentation.js";
import { dockGeometry, presentation as filesPresentation } from "./dock-files.js";
export { script } from "./dock-files.js";

const session = filesPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sideColumns: { [sideColumnKey(session)]: { open: ["terminal", "browser", "documents"], shown: "browser", hidden: false } },
};
export const readySelector = 'form[aria-label="Browser navigation"] button[aria-label="Reload"]:not(:disabled)';
/** look.md §9.3: renderer toolbar; the scripted shell does not draw a native web page. */
export const geometry = [
  ...dockGeometry,
  { selector: 'input[aria-label="Address"]', fontSize: 12, paddingLeft: 8, paddingTop: 4 },
  { selector: 'form[aria-label="Browser navigation"] button', width: 24, height: 24 },
  { selector: 'form[aria-label="Browser navigation"] button svg', width: 14, height: 14 },
];
