import type { LadderName } from "@agent-harness/theme";
import { PromptScene } from "../prompt-scene.js";
/** look.md §10.3 and §16: the real plan request settled state. */
export default function Scene({ ladder }: { readonly ladder: LadderName }) { return <PromptScene kind="plan" state="settled" ladder={ladder} />; }
export const readySelector = '[data-prompt-state="settled"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }];
