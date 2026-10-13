import { sessionScene, geometry as columnGeometry } from "./session-conversation.js";
import type { SceneViewport } from "../scene-registry.js";
export default await sessionScene("timestamps");
export const readySelector = '[data-tool-call="timed-read"] time';
export const geometry = (viewport: SceneViewport) => [
  ...columnGeometry(viewport),
  { selector: '[aria-label="Transcript"] time', unbroken: true, contentFits: true },
];
