import type { LadderName } from "@agent-harness/theme";
import { PromptScene, noticePermissionGeometry } from "../prompt-scene.js";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";
export default function Scene({ ladder }: { readonly ladder: LadderName }) {
  return <PromptScene kind="permission" ladder={ladder} withNotices short />;
}
/** look.md §3, §9.1 and §16: text scales; the desktop frame and stored sidebar width stay fixed. */
export const presentation: Partial<PresentationValues> = { textSize: 20 };
export const geometry: readonly SceneGeometry[] = [
  ...noticePermissionGeometry,
  { selector: "[data-window-header]", height: 44 },
  { selector: "[data-sidebar-card]", width: 224 },
  { selector: 'nav[aria-label="Sessions"] button[aria-label="New session"]', visibleWithin: '[data-sidebar-card]', contentFits: true },
  { selector: 'nav[aria-label="Sessions"] button[aria-label="New session"] span span', visibleWithin: 'button', contentFits: true, fontSize: 0.8 * 16 * 20 / 14 },
  { selector: 'nav[aria-label="Sessions"] kbd', visibleWithin: 'button', contentFits: true, fontSize: 11 * 20 / 14 },
  { selector: 'nav[aria-label="Sessions"] > div:last-of-type button span', visibleWithin: 'button', contentFits: true, fontSize: 11 * 20 / 14 },
];

export const readySelector = 'main:has([aria-label="Notifications"] li:nth-child(2)) [aria-label="Parked prompt"]';
