import { sessionScene } from "./session-conversation.js";
export default await sessionScene("find");
export const geometry = [
  { selector: '[aria-label="Transcript"] > div', width: 920 },
  { selector: '[data-measure="transcript-spine"]', width: 56 },
  { selector: '[aria-label="Find in the conversation"] button', height: 24 },
];
