import type { SceneModule, SceneGeometry } from "../scene-registry.js";
import type { PresentationValues } from "../../src/presentation.js";
import { presentation as filesPresentation } from "./dock-files.js";
export { script } from "./dock-files.js";

export const presentation: Partial<PresentationValues> = {
  ...filesPresentation,
  sideColumns: Object.fromEntries(Object.keys(filesPresentation.sideColumns!).map((key) => [key, {
    open: ["browser"], shown: "browser", hidden: false,
  }])),
};
export const arrange: NonNullable<SceneModule["arrange"]> = (_world, shell) => {
  shell.answer("webView.create", async ({ url }) => {
    shell.changeWebView("view-1", { url: url === "about:blank" ? "https://example.org/slow" : url, canGoBack: false, canGoForward: false, loading: true });
    return "view-1";
  });
};
export const readySelector = '[aria-label="Stop"]';
/** look.md §9.3: the loading page offers a 24px Stop control with a 14px glyph. */
export const geometry: readonly SceneGeometry[] = [
  { selector: '[aria-label="Stop"]', width: 24, height: 24 },
  { selector: '[aria-label="Stop"] svg', width: 14, height: 14 },
];
