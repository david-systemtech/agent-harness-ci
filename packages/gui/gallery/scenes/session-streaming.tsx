import { sessionScene } from "./session-conversation.js";
export default await sessionScene("streaming");
export const geometry = [
  { selector: '[aria-label="Transcript"] > div', width: 920 },
  { selector: '[data-measure="transcript-spine"]', width: 56 },
];
