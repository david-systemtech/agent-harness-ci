import type { LadderName } from "@agent-harness/theme";
import { PromptScene } from "../prompt-scene.js";
/** look.md §10.3 and §16: the real denylist request busy state. */
export default function Scene({ ladder }: { readonly ladder: LadderName }) { return <PromptScene kind="denylist" state="busy" ladder={ladder} />; }
export const readySelector = '[data-prompt-state="busy"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }];
