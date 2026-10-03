import type { LadderName } from "@agent-harness/theme";
import { PromptScene, promptGeometry } from "../prompt-scene.js";

/** A refused answer keeps the long request, note and decisions on the card. */
export default function Scene({ ladder }: { readonly ladder: LadderName }) {
  return <PromptScene kind="permission" state="error" ladder={ladder} />;
}
export const readySelector = '[data-prompt-state="error"]';
export const geometry = [
  ...promptGeometry("permission"),
  { selector: '[aria-label="Permission decision"] [role="status"]', visibleWithin: '[aria-label="Parked prompt"]' },
];
