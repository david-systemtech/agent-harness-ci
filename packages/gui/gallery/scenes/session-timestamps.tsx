import { sessionScene, geometry as columnGeometry } from "./session-conversation.js";
import type { SceneViewport } from "../scene-registry.js";
export default await sessionScene("timestamps");
export const readySelector = '[data-tool-call="timed-read"] time';
const SPINE = '[data-measure="transcript-spine"]';
/** Times at text size 20 (look.md §3: text scales): the rem-sized spine grows with it, 56 px × 20 / 14. */
export const geometry = (viewport: SceneViewport) => [
  ...columnGeometry(viewport).map((measure) => measure.selector === SPINE ? { ...measure, width: 56 * 20 / 14 } : measure),
  { selector: '[aria-label="Transcript"] time', unbroken: true, contentFits: true },
];
