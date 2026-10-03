import type { LadderName } from "@agent-harness/theme";
import { PromptScene, promptGeometry } from "../prompt-scene.js";

/** A refused answer keeps the long plan, note and decisions on the card. */
export default function Scene({ ladder }: { readonly ladder: LadderName }) {
  return <PromptScene kind="plan" state="error" ladder={ladder} />;
}
export const readySelector = '[data-prompt-state="error"]';
export const geometry = [
  ...promptGeometry("plan"),
  { selector: '[aria-label="Parked prompt"] [role="status"]', visibleWithin: '[aria-label="Parked prompt"]' },
];
