import type { SceneGeometry, SceneViewport } from "../scene-registry.js";
import { geometry as conversationGeometry, sessionScene } from "./session-conversation.js";
export default await sessionScene("find");
export const geometry = (viewport: SceneViewport): readonly SceneGeometry[] => [
  ...conversationGeometry(viewport),
  { selector: '[aria-label="Find in the conversation"] button', height: 24 },
];
